// A small client for the ComfyUI HTTP API, through the GPU server's proxy.
//
//   upload()   puts an image or video in ComfyUI's input folder
//   prepare()  fills unset node settings from the server's own defaults and
//              checks every node and input exists, before anything is queued
//   run()      queues a graph, waits for it, and returns its output files

export class Comfy {
  constructor({ url, headers }) {
    this.url = url.replace(/\/$/, '');
    this.headers = headers;
    this.info = null;
  }

  async request(route, init = {}) {
    const r = await fetch(`${this.url}${route}`, { ...init, headers: { ...this.headers, ...(init.headers ?? {}) } });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`ComfyUI ${route}: ${r.status} ${body.slice(0, 600)}`);
    }
    return r;
  }

  async json(route, init) {
    return (await this.request(route, init)).json();
  }

  async stats() {
    return this.json('/system_stats');
  }

  async objectInfo() {
    this.info ??= await this.json('/object_info');
    return this.info;
  }

  /** Uploads a file into input/<subfolder>/ and returns the name nodes refer to it by. */
  async upload(buffer, filename, subfolder = 'dod') {
    const form = new FormData();
    form.append('image', new Blob([buffer]), filename);
    form.append('subfolder', subfolder);
    form.append('type', 'input');
    form.append('overwrite', 'true');
    const r = await this.json('/upload/image', { method: 'POST', body: form });
    return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
  }

  /**
   * Checks a graph against the server's node definitions. Required settings a
   * graph leaves out get the node's default, so small node updates don't
   * break us; anything else wrong is reported before the GPU spends time on it.
   */
  async prepare(graph) {
    const info = await this.objectInfo();
    const problems = [];
    for (const [id, node] of Object.entries(graph)) {
      const def = info[node.class_type];
      if (!def) {
        problems.push(`node ${id}: ${node.class_type} is not installed on the server`);
        continue;
      }
      const required = def.input?.required ?? {};
      const optional = def.input?.optional ?? {};
      for (const [name, spec] of Object.entries(required)) {
        if (name in node.inputs) continue;
        const [type, opts] = spec;
        if (Array.isArray(type)) node.inputs[name] = opts?.default ?? type[0];
        else if (opts && 'default' in opts) node.inputs[name] = opts.default;
        else problems.push(`node ${id} (${node.class_type}): missing ${name}`);
      }
      for (const name of Object.keys(node.inputs)) {
        if (!(name in required) && !(name in optional)) problems.push(`node ${id} (${node.class_type}): no input called ${name}`);
      }
      // A model file the graph names but the server doesn't have.
      for (const [name, value] of Object.entries(node.inputs)) {
        const spec = required[name] ?? optional[name];
        const choices = Array.isArray(spec?.[0]) ? spec[0] : spec?.[0] === 'COMBO' ? spec?.[1]?.options : null;
        if (choices && typeof value === 'string' && /\.(safetensors|ckpt|pt|pth|onnx|gguf)$/.test(value) && !choices.includes(value)) {
          problems.push(`node ${id} (${node.class_type}): ${value} is not on the server`);
        }
      }
    }
    if (problems.length) throw new Error(`The workflow doesn't match the server:\n  ${problems.join('\n  ')}`);
    return graph;
  }

  /** Queues a graph and waits for it. Returns the output files it saved. */
  async run(graph, { onProgress, timeoutMs = 60 * 60 * 1000, signal } = {}) {
    await this.prepare(graph);
    const queued = await this.json('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: 'dod-devtools' }),
    });
    if (queued.node_errors && Object.keys(queued.node_errors).length) {
      throw new Error(`ComfyUI rejected the workflow: ${JSON.stringify(queued.node_errors).slice(0, 800)}`);
    }
    const id = queued.prompt_id;
    const started = Date.now();
    for (;;) {
      if (signal?.aborted) {
        await this.request('/interrupt', { method: 'POST' }).catch(() => undefined);
        throw new Error('Cancelled');
      }
      if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for ComfyUI');
      const hist = await this.json(`/history/${id}`);
      const entry = hist[id];
      if (entry) {
        const st = entry.status ?? {};
        if (st.status_str === 'error') {
          const err = (st.messages ?? []).find((m) => m[0] === 'execution_error')?.[1];
          throw new Error(`ComfyUI failed in ${err?.node_type ?? 'a node'}: ${err?.exception_message ?? 'see the server log'}`);
        }
        if (st.completed || entry.outputs) return { id, files: outputFiles(entry.outputs ?? {}), seconds: (Date.now() - started) / 1000 };
      } else if (onProgress) {
        const q = await this.json('/queue').catch(() => null);
        const ahead = q ? (q.queue_pending ?? []).findIndex((p) => p[1] === id) : -1;
        onProgress(ahead > 0 ? `waiting behind ${ahead} job${ahead > 1 ? 's' : ''}` : `running for ${Math.round((Date.now() - started) / 1000)}s`);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  async download(file) {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' });
    return Buffer.from(await (await this.request(`/view?${q}`)).arrayBuffer());
  }
}

/** Every file a run saved, whatever the node called its output list. */
function outputFiles(outputs) {
  const files = [];
  for (const out of Object.values(outputs)) {
    for (const key of ['images', 'gifs', 'videos', 'video']) {
      for (const f of out?.[key] ?? []) if (f?.filename) files.push({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output' });
    }
  }
  return files;
}
