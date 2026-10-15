// The three ComfyUI workflows, as API graphs. Each is a straight translation
// of an official template in comfy/templates/ (the templates use subgraphs,
// which the API can't run), with the 4-step speed LoRAs switched on.
//
//   sideView      Qwen-Image-Edit-2511: a fighter's front art -> a side view;
//                 with a second image, the side view (+ front) -> a pose
//   imageToVideo  Wan 2.2 14B I2V: a start pose + a prompt -> a clip; with an
//                 end pose too, first-last-frame (WanFirstLastFrameToVideo,
//                 same models), so loops start and end on the same pose
//   animate       Wan 2.2 Animate: a side view + a driving video -> the same
//                 motion performed by this fighter (pose taken with DWPose)
//
// Model file names match comfy/models.json. Settings (steps, cfg, shift,
// LoRA strength, sampler...) come from content/generation.json via
// settings.mjs; the defaults here match the templates.

function graph() {
  const nodes = {};
  let n = 0;
  const add = (class_type, inputs = {}) => {
    const id = String(++n);
    nodes[id] = { class_type, inputs };
    return id;
  };
  return { nodes, add, out: (id, slot = 0) => [id, slot] };
}

/**
 * Qwen-Image-Edit-2511, 4-step Lightning: edit an image with a prompt. The
 * output is image's size; image2 is an extra reference (a pose takes the side
 * view as image and the front art as image2).
 */
export function sideView({ image, image2, prompt, seed, prefix = 'dod/side', s = {} }) {
  const { steps = 4, cfg = 1, shift = 3.1, lora: loraStrength = 1, sampler = 'euler', scheduler = 'simple' } = s;
  const g = graph();
  const unet = g.add('UNETLoader', { unet_name: 'qwen_image_edit_2511_fp8mixed.safetensors', weight_dtype: 'default' });
  const clip = g.add('CLIPLoader', { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' });
  const vae = g.add('VAELoader', { vae_name: 'qwen_image_vae.safetensors' });
  const sampling = g.add('ModelSamplingAuraFlow', { model: g.out(unet), shift });
  const norm = g.add('CFGNorm', { model: g.out(sampling), strength: 1 });
  const lora = g.add('LoraLoaderModelOnly', { model: g.out(norm), lora_name: 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', strength_model: loraStrength });
  const load = g.add('LoadImage', { image });
  const scaled = g.add('FluxKontextImageScale', { image: g.out(load) });
  const extra = image2 ? { image2: g.out(g.add('LoadImage', { image: image2 })) } : {};
  const enc = (text) =>
    g.add('FluxKontextMultiReferenceLatentMethod', {
      conditioning: g.out(g.add('TextEncodeQwenImageEditPlus', { clip: g.out(clip), vae: g.out(vae), image1: g.out(scaled), ...extra, prompt: text })),
      reference_latents_method: 'index_timestep_zero',
    });
  const pos = enc(prompt);
  const neg = enc('');
  const latent = g.add('VAEEncode', { pixels: g.out(scaled), vae: g.out(vae) });
  const sample = g.add('KSampler', {
    model: g.out(lora), positive: g.out(pos), negative: g.out(neg), latent_image: g.out(latent),
    seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 1,
  });
  const decoded = g.add('VAEDecode', { samples: g.out(sample), vae: g.out(vae) });
  g.add('SaveImage', { images: g.out(decoded), filename_prefix: prefix });
  return g.nodes;
}

/**
 * Wan 2.2 14B image-to-video with the 4-step LoRAs: high noise (the motion)
 * then low noise (the detail). image is the first frame; end, when given, the
 * last (Wan's first-last-frame conditioning).
 *
 * The speed LoRAs flatten motion and, at CFG 1, the prompt barely steers it.
 * So the first motionSteps run on the plain high-noise model at cfgHigh (real
 * guidance, the prompt and negative count), then the LoRA'd models finish at
 * CFG 1 (the community's "three sampler" setup). motionSteps 0 is the plain
 * two-sampler template.
 */
export function imageToVideo({ image, end, prompt, negative, width = 640, height = 640, frames = 33, fps = 16, seed, prefix = 'dod/i2v', s = {} }) {
  const { steps = 4, cfg = 1, shift = 5, loraHigh = 1, loraLow = 1, sampler = 'euler', scheduler = 'simple' } = s;
  const split = Math.min(steps - 1, Math.max(1, s.split ?? Math.floor(steps / 2)));
  const motionSteps = Math.min(split, Math.max(0, Math.round(s.motionSteps ?? 0)));
  const cfgHigh = s.cfgHigh ?? cfg;
  // loraVersion 2: lightx2v's newer 4-step LoRAs (1022), which move more than the original v1.
  const [loraHighFile, loraLowFile] = Number(s.loraVersion) >= 2
    ? ['wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors', 'wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors']
    : ['wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors', 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors'];
  // PainterI2V (start frame only) pushes motion past what the 4-step LoRAs give.
  const amplitude = !end && Number(s.motionAmplitude) > 1 ? Math.min(2, Number(s.motionAmplitude)) : 0;
  const g = graph();
  const clip = g.add('CLIPLoader', { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' });
  const vae = g.add('VAELoader', { vae_name: 'wan_2.1_vae.safetensors' });
  const model = (unet, lora, strength) =>
    g.add('ModelSamplingSD3', {
      model: g.out(g.add('LoraLoaderModelOnly', { model: g.out(unet), lora_name: lora, strength_model: strength })),
      shift,
    });
  const highUnet = g.add('UNETLoader', { unet_name: 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors', weight_dtype: 'default' });
  const high = model(highUnet, loraHighFile, loraHigh);
  // The motion stage: the same high-noise model (loaded once) with no speed LoRA.
  const raw = motionSteps ? g.add('ModelSamplingSD3', { model: g.out(highUnet), shift }) : null;
  const low = model(g.add('UNETLoader', { unet_name: 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors', weight_dtype: 'default' }), loraLowFile, loraLow);
  const pos = g.add('CLIPTextEncode', { clip: g.out(clip), text: prompt });
  const neg = g.add('CLIPTextEncode', { clip: g.out(clip), text: negative ?? '' });
  const load = g.add('LoadImage', { image });
  const i2v = end
    ? g.add('WanFirstLastFrameToVideo', {
        positive: g.out(pos), negative: g.out(neg), vae: g.out(vae), start_image: g.out(load), end_image: g.out(g.add('LoadImage', { image: end })),
        width, height, length: frames, batch_size: 1,
      })
    : amplitude
      ? g.add('PainterI2V', {
          positive: g.out(pos), negative: g.out(neg), vae: g.out(vae), start_image: g.out(load),
          width, height, length: frames, batch_size: 1, motion_amplitude: amplitude,
        })
      : g.add('WanImageToVideo', {
          positive: g.out(pos), negative: g.out(neg), vae: g.out(vae), start_image: g.out(load),
          width, height, length: frames, batch_size: 1,
        });
  const motion = raw
    ? g.add('KSamplerAdvanced', {
        model: g.out(raw), add_noise: 'enable', noise_seed: seed, steps, cfg: cfgHigh, sampler_name: sampler, scheduler,
        positive: g.out(i2v, 0), negative: g.out(i2v, 1), latent_image: g.out(i2v, 2),
        start_at_step: 0, end_at_step: motionSteps, return_with_leftover_noise: 'enable',
      })
    : null;
  const first = g.add('KSamplerAdvanced', {
    model: g.out(high), add_noise: motion ? 'disable' : 'enable', noise_seed: motion ? 0 : seed, steps, cfg: motion ? cfg : cfgHigh, sampler_name: sampler, scheduler,
    positive: g.out(i2v, 0), negative: g.out(i2v, 1), latent_image: motion ? g.out(motion) : g.out(i2v, 2),
    start_at_step: motionSteps, end_at_step: split, return_with_leftover_noise: 'enable',
  });
  const second = g.add('KSamplerAdvanced', {
    model: g.out(low), add_noise: 'disable', noise_seed: 0, steps, cfg, sampler_name: sampler, scheduler,
    positive: g.out(i2v, 0), negative: g.out(i2v, 1), latent_image: g.out(first),
    start_at_step: split, end_at_step: 10000, return_with_leftover_noise: 'disable',
  });
  const decoded = g.add('VAEDecode', { samples: g.out(second), vae: g.out(vae) });
  const video = g.add('CreateVideo', { images: g.out(decoded), fps });
  g.add('SaveVideo', { video: g.out(video), filename_prefix: prefix, format: 'auto', codec: 'auto' });
  return g.nodes;
}

/**
 * Wan 2.2 Animate, animation mode: the reference performs the driving video's
 * motion. With no background video or mask, the background comes from the
 * reference image, which is a flat green frame, so the result keys cleanly.
 */
export function animate({ reference, motion, prompt, negative, width = 640, height = 640, frames = 77, fps = 16, seed, prefix = 'dod/animate', s = {} }) {
  const { steps = 6, cfg = 1, shift = 8, lora: loraStrength = 1, sampler = 'euler', scheduler = 'simple', hands = true, face = true, poseResolution = 512 } = s;
  const g = graph();
  const unet = g.add('UNETLoader', { unet_name: 'Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors', weight_dtype: 'default' });
  const lora = g.add('LoraLoaderModelOnly', { model: g.out(unet), lora_name: 'lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors', strength_model: loraStrength });
  const model = g.add('ModelSamplingSD3', { model: g.out(lora), shift });
  const clip = g.add('CLIPLoader', { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' });
  const vae = g.add('VAELoader', { vae_name: 'wan_2.1_vae.safetensors' });
  const vision = g.add('CLIPVisionLoader', { clip_name: 'clip_vision_h.safetensors' });
  const ref = g.add('LoadImage', { image: reference });
  const visionOut = g.add('CLIPVisionEncode', { clip_vision: g.out(vision), image: g.out(ref), crop: 'none' });
  const pos = g.add('CLIPTextEncode', { clip: g.out(clip), text: prompt });
  const neg = g.add('CLIPTextEncode', { clip: g.out(clip), text: negative ?? '' });

  // The driving video, at the output size, read as poses (body and hands) and faces.
  const video = g.add('LoadVideo', { file: motion });
  const parts = g.add('GetVideoComponents', { video: g.out(video) });
  const sized = g.add('ImageScale', { image: g.out(parts, 0), upscale_method: 'lanczos', width, height, crop: 'center' });
  const pose = (hand, body, face) =>
    g.add('DWPreprocessor', {
      image: g.out(sized), detect_hand: hand, detect_body: body, detect_face: face, resolution: poseResolution,
      bbox_detector: 'yolox_l.onnx', pose_estimator: 'dw-ll_ucoco_384_bs5.torchscript.pt', scale_stick_for_xinsr_cn: 'disable',
    });
  const on = (b) => (b ? 'enable' : 'disable');
  const poses = pose(on(hands), 'enable', 'disable');
  const faces = pose('disable', 'disable', on(face));

  const wan = g.add('WanAnimateToVideo', {
    positive: g.out(pos), negative: g.out(neg), vae: g.out(vae), clip_vision_output: g.out(visionOut),
    reference_image: g.out(ref), pose_video: g.out(poses), face_video: g.out(faces),
    width, height, length: frames, batch_size: 1, continue_motion_max_frames: 5, video_frame_offset: 0,
  });
  const sample = g.add('KSampler', {
    model: g.out(model), positive: g.out(wan, 0), negative: g.out(wan, 1), latent_image: g.out(wan, 2),
    seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 1,
  });
  const trimmed = g.add('TrimVideoLatent', { samples: g.out(sample), trim_amount: g.out(wan, 3) });
  const decoded = g.add('VAEDecode', { samples: g.out(trimmed), vae: g.out(vae) });
  const kept = g.add('ImageFromBatch', { image: g.out(decoded), batch_index: g.out(wan, 4), length: 4096 });
  const out = g.add('CreateVideo', { images: g.out(kept), fps });
  g.add('SaveVideo', { video: g.out(out), filename_prefix: prefix, format: 'auto', codec: 'auto' });
  return g.nodes;
}

/**
 * Qwen-Image-Edit-2511 painting over a blockout: images[0] (scaled to exactly
 * width x height, which sets the output size) is repainted as the prompt
 * says, styled on images[1] (and images[2]).
 */
export function paintOver({ images, prompt, seed, width, height, prefix = 'dod/map', s = {} }) {
  // denoise below 1 starts from the blockout itself, which pins the painting to its flat,
  // straight-on shapes (Qwen otherwise drifts to three-quarter views).
  const { steps = 4, cfg = 1, shift = 3.1, lora: loraStrength = 1, sampler = 'euler', scheduler = 'simple', denoise = 1 } = s;
  const g = graph();
  const unet = g.add('UNETLoader', { unet_name: 'qwen_image_edit_2511_fp8mixed.safetensors', weight_dtype: 'default' });
  const clip = g.add('CLIPLoader', { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' });
  const vae = g.add('VAELoader', { vae_name: 'qwen_image_vae.safetensors' });
  const sampling = g.add('ModelSamplingAuraFlow', { model: g.out(unet), shift });
  const norm = g.add('CFGNorm', { model: g.out(sampling), strength: 1 });
  const lora = g.add('LoraLoaderModelOnly', { model: g.out(norm), lora_name: 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', strength_model: loraStrength });
  const loads = images.slice(0, 3).map((image) => g.add('LoadImage', { image }));
  const first = g.add('ImageScale', { image: g.out(loads[0]), upscale_method: 'lanczos', width, height, crop: 'disabled' });
  const refs = { image1: g.out(first) };
  loads.slice(1).forEach((id, i) => (refs[`image${i + 2}`] = g.out(id)));
  const enc = (text) =>
    g.add('FluxKontextMultiReferenceLatentMethod', {
      conditioning: g.out(g.add('TextEncodeQwenImageEditPlus', { clip: g.out(clip), vae: g.out(vae), ...refs, prompt: text })),
      reference_latents_method: 'index_timestep_zero',
    });
  const pos = enc(prompt);
  const neg = enc('');
  const latent = g.add('VAEEncode', { pixels: g.out(first), vae: g.out(vae) });
  const sample = g.add('KSampler', {
    model: g.out(lora), positive: g.out(pos), negative: g.out(neg), latent_image: g.out(latent),
    seed, steps, cfg, sampler_name: sampler, scheduler, denoise,
  });
  const decoded = g.add('VAEDecode', { samples: g.out(sample), vae: g.out(vae) });
  g.add('SaveImage', { images: g.out(decoded), filename_prefix: prefix });
  return g.nodes;
}
