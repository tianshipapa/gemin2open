// =============================================================
// Cloudflare Pages 单文件部署：Gemini → OpenAI 格式兼容代理
// 使用方法：
//   1) 在 Cloudflare Dashboard 创建一个 Pages 项目，选择"直接上传"
//   2) 新建一个文件夹，把本文件命名为 _worker.js 放进去（注意文件名前有下划线）
//   3) 可额外放一个 index.html（可选），把文件夹拖到 Pages 上传
//   4) 部署完成后，Base URL 填  https://你的pages域名/v1
//      API Key 填你在 Google AI Studio 申请的 Gemini API Key（AIza...开头）
//
// 支持：
//   - GET  /v1/models              → 模型列表
//   - POST /v1/chat/completions    → 对话（含流式 SSE、tool calls、多模态、thinking、json 输出）
//   - POST /v1/embeddings          → 向量嵌入
//   - CORS 预检自动通过
//
// 代码基于 PublicAffairs/openai-gemini（MIT）改造，专为 Pages _worker.js 单文件使用。
// =============================================================

// ---------- 工具函数：base64（替代 node:buffer） ----------
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000; // 每块 32KB，避免栈溢出
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ---------- 错误与 CORS ----------
class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

const fixCors = ({ headers, status, statusText }) => {
  headers = new Headers(headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return { headers, status, statusText };
};

const handleOPTIONS = () =>
  new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    },
  });

// ---------- 常量 ----------
const BASE_URL = "https://generativelanguage.googleapis.com";
const API_VERSION = "v1beta";
const API_CLIENT = "google-genai-sdk/1.34.0";

const makeHeaders = (apiKey, more) => ({
  "x-goog-api-client": API_CLIENT,
  ...(apiKey && { "x-goog-api-key": apiKey }),
  ...more,
});

// ---------- 首页提示（访问根路径时返回） ----------
const INDEX_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Gemini → OpenAI Proxy</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:60px auto;padding:0 20px;color:#222}
code{background:#f4f4f4;padding:2px 6px;border-radius:4px}pre{background:#1e1e1e;color:#e6e6e6;padding:16px;border-radius:8px;overflow:auto}
</style></head><body>
<h1>Gemini → OpenAI 兼容代理已运行</h1>
<p>这是部署在 Cloudflare Pages 上的单文件 <code>_worker.js</code>，把 Gemini API 转换成 OpenAI 格式。</p>
<h2>使用方式</h2>
<ul>
<li><b>Base URL</b>: <code>https://你的域名/v1</code></li>
<li><b>API Key</b>: Google AI Studio 申请的 Key（<code>AIza...</code> 开头）</li>
<li>支持 <code>/v1/chat/completions</code>、<code>/v1/models</code>、<code>/v1/embeddings</code></li>
</ul>
<h2>测试</h2>
<pre>curl https://你的域名/v1/models \\
  -H "Authorization: Bearer 你的GEMINI_API_KEY"</pre>
<p>流式 / 多模态 / Function Calling / thinking / JSON 模式均已支持。</p>
</body></html>`;

// ---------- Models ----------
async function handleModels(apiKey) {
  const response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
    headers: makeHeaders(apiKey),
  });
  let body = response.body;
  if (response.ok) {
    const { models } = JSON.parse(await response.text());
    body = JSON.stringify(
      {
        object: "list",
        data: models.map(({ name }) => ({
          id: name.replace("models/", ""),
          object: "model",
          created: 0,
          owned_by: "google",
        })),
      },
      null,
      "  "
    );
  }
  return new Response(body, fixCors(response));
}

// ---------- Embeddings ----------
const DEFAULT_EMBEDDINGS_MODEL = "gemini-embedding-001";
async function handleEmbeddings(req, apiKey) {
  let modelFull, model;
  if (typeof req.model !== "string") throw new HttpError("model is not specified", 400);
  if (req.model.startsWith("models/")) {
    modelFull = req.model;
    model = modelFull.substring(7);
  } else if (req.model.startsWith("gemini-")) {
    model = req.model;
  } else {
    model = DEFAULT_EMBEDDINGS_MODEL;
  }
  modelFull ??= "models/" + model;
  if (!Array.isArray(req.input)) req.input = [req.input];
  const response = await fetch(`${BASE_URL}/${API_VERSION}/${modelFull}:batchEmbedContents`, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      requests: req.input.map((text) => ({
        model: modelFull,
        content: { parts: { text } },
        outputDimensionality: req.dimensions,
      })),
    }),
  });
  let body = response.body;
  if (response.ok) {
    const { embeddings } = JSON.parse(await response.text());
    body = JSON.stringify(
      {
        object: "list",
        data: embeddings.map(({ values }, index) => ({
          object: "embedding",
          index,
          embedding: values,
        })),
        model,
      },
      null,
      "  "
    );
  }
  return new Response(body, fixCors(response));
}

// ---------- Chat Completions ----------
const DEFAULT_MODEL = "gemini-flash-latest";
async function handleCompletions(req, apiKey) {
  let model = req.model;
  if (typeof model !== "string") throw new HttpError("model is not specified", 400);
  if (model.startsWith("models/")) model = model.substring(7);
  else if (!model.startsWith("gemini-") && !model.startsWith("gemma-")) model = DEFAULT_MODEL;

  const isV3 = model.startsWith("gemini-3");
  let body = await transformRequest(req, isV3);

  const extra = req.extra_body?.google;
  if (extra) {
    if (extra.safety_settings) body.safetySettings = extra.safety_settings;
    if (extra.cached_content) body.cachedContent = extra.cached_content;
    if (extra.thinking_config) body.generationConfig.thinkingConfig = extra.thinking_config;
  }
  if (model.endsWith(":search")) {
    model = model.slice(0, -7);
    body.tools ??= [];
    body.tools.push({ googleSearch: {} });
  } else if (req.model?.includes("-search-preview")) {
    body.tools ??= [];
    body.tools.push({ googleSearch: {} });
  }

  const TASK = req.stream ? "streamGenerateContent" : "generateContent";
  let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
  if (req.stream) url += "?alt=sse";
  const response = await fetch(url, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });

  let respBody = response.body;
  if (response.ok) {
    const id = "chatcmpl-" + generateId();
    const shared = {};
    if (req.stream) {
      respBody = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(
          new TransformStream({
            transform: parseStream,
            flush: parseStreamFlush,
            buffer: "",
            shared,
          })
        )
        .pipeThrough(
          new TransformStream({
            transform: toOpenAiStream,
            flush: toOpenAiStreamFlush,
            streamIncludeUsage: req.stream_options?.include_usage,
            model,
            id,
            last: [],
            shared,
          })
        )
        .pipeThrough(new TextEncoderStream());
    } else {
      const text = await response.text();
      try {
        const parsed = JSON.parse(text);
        if (!parsed.candidates) throw new Error("Invalid completion object");
        respBody = processCompletionsResponse(parsed, model, id);
      } catch (e) {
        console.error("Error parsing response:", e);
        return new Response(text, fixCors(response));
      }
    }
  }
  return new Response(respBody, fixCors(response));
}

// ---------- 请求转换 ----------
const adjustProps = (schemaPart) => {
  if (typeof schemaPart !== "object" || schemaPart === null) return;
  if (Array.isArray(schemaPart)) {
    schemaPart.forEach(adjustProps);
  } else {
    if (schemaPart.type === "object" && schemaPart.properties && schemaPart.additionalProperties === false) {
      delete schemaPart.additionalProperties;
    }
    Object.values(schemaPart).forEach(adjustProps);
  }
};
const adjustSchema = (schema) => {
  const obj = schema[schema.type];
  if (obj) {
    delete obj.strict;
    delete obj.parameters?.$schema;
  }
  return adjustProps(schema);
};

const harmCategory = [
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
];
const safetySettings = harmCategory.map((category) => ({ category, threshold: "BLOCK_NONE" }));

const fieldsMap = {
  frequency_penalty: "frequencyPenalty",
  max_completion_tokens: "maxOutputTokens",
  max_tokens: "maxOutputTokens",
  n: "candidateCount",
  presence_penalty: "presencePenalty",
  seed: "seed",
  stop: "stopSequences",
  temperature: "temperature",
  top_k: "topK",
  top_p: "topP",
};
const thinkingBudgetMap = { none: 0, minimal: 1024, low: 1024, medium: 8192, high: 24576, xhigh: 32768 };
const thinkingLevelMap = { none: "minimal", xhigh: "high" };

const transformConfig = (req, isV3) => {
  const cfg = {};
  for (const key in req) {
    const matchedKey = fieldsMap[key];
    if (matchedKey) cfg[matchedKey] = req[key];
  }
  if (req.response_format) {
    switch (req.response_format.type) {
      case "json_schema":
        adjustSchema(req.response_format);
        cfg.responseSchema = req.response_format.json_schema?.schema;
        if (cfg.responseSchema && "enum" in cfg.responseSchema) {
          cfg.responseMimeType = "text/x.enum";
          break;
        }
      // fallthrough
      case "json_object":
        cfg.responseMimeType = "application/json";
        break;
      case "text":
        cfg.responseMimeType = "text/plain";
        break;
      default:
        throw new HttpError("Unsupported response_format.type", 400);
    }
  }
  if (req.reasoning_effort) {
    cfg.thinkingConfig = isV3
      ? { thinkingLevel: thinkingLevelMap[req.reasoning_effort] ?? req.reasoning_effort }
      : { thinkingBudget: thinkingBudgetMap[req.reasoning_effort] };
  }
  return cfg;
};

const parseImg = async (url) => {
  let mimeType, data;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} (${url})`);
    mimeType = r.headers.get("content-type");
    data = arrayBufferToBase64(await r.arrayBuffer());
  } else {
    const match = url.match(/^data:(?<mimeType>.*?)(;base64)?,(?<data>.*)$/);
    if (!match) throw new HttpError("Invalid image data: " + url, 400);
    ({ mimeType, data } = match.groups);
  }
  return { inlineData: { mimeType, data } };
};

const transformFnResponse = ({ content, tool_call_id }, parts) => {
  if (!parts.calls) throw new HttpError("No function calls found in the previous message", 400);
  let response;
  try { response = JSON.parse(content); } catch { throw new HttpError("Invalid function response: " + content, 400); }
  if (typeof response !== "object" || response === null || Array.isArray(response)) response = { result: response };
  if (!tool_call_id) throw new HttpError("tool_call_id not specified", 400);
  const { i, name } = parts.calls[tool_call_id] ?? {};
  if (!name) throw new HttpError("Unknown tool_call_id: " + tool_call_id, 400);
  if (parts[i]) throw new HttpError("Duplicated tool_call_id: " + tool_call_id, 400);
  parts[i] = {
    functionResponse: {
      id: tool_call_id.startsWith("call_") ? null : tool_call_id,
      name,
      response,
    },
  };
};

const transformFnCalls = ({ tool_calls }) => {
  const calls = {};
  const parts = tool_calls.map(({ function: { arguments: argstr, name }, id, type, extra_content }, i) => {
    if (type !== "function") throw new HttpError(`Unsupported tool_call type: "${type}"`, 400);
    let args;
    try { args = JSON.parse(argstr); } catch { throw new HttpError("Invalid function arguments: " + argstr, 400); }
    calls[id] = { i, name };
    return {
      functionCall: {
        id: id.startsWith("call_") ? null : id,
        name,
        args,
      },
      thoughtSignature: extra_content?.google?.thought_signature,
    };
  });
  parts.calls = calls;
  return parts;
};

const transformMsg = async ({ content, extra_content }) => {
  const thoughtSignature = extra_content?.google?.thought_signature;
  const parts = [];
  if (!Array.isArray(content)) {
    parts.push({ text: content ?? "", thoughtSignature });
    return parts;
  }
  for (const item of content) {
    switch (item.type) {
      case "text":
        parts.push({ text: item.text });
        break;
      case "image_url":
        parts.push(await parseImg(item.image_url.url));
        break;
      case "input_audio":
        parts.push({
          inlineData: {
            mimeType: "audio/" + item.input_audio.format,
            data: item.input_audio.data,
          },
        });
        break;
      default:
        throw new HttpError(`Unknown "content" item type: "${item.type}"`, 400);
    }
  }
  if (thoughtSignature) {
    if (parts.length === 1) parts[0].thoughtSignature = thoughtSignature;
    else parts.push({ text: "", thoughtSignature });
  }
  if (content.every((item) => item.type === "image_url")) {
    parts.push({ text: "" });
  }
  return parts;
};

const transformMessages = async (messages) => {
  if (!messages) return {};
  const contents = [];
  let system_instruction;
  for (const item of messages) {
    switch (item.role) {
      case "system":
        system_instruction = { parts: await transformMsg(item) };
        continue;
      case "tool": {
        let { role, parts } = contents[contents.length - 1] ?? {};
        if (role !== "function") {
          const calls = parts?.calls;
          parts = [];
          parts.calls = calls;
          contents.push({ role: "function", parts });
        }
        transformFnResponse(item, parts);
        continue;
      }
      case "assistant":
        item.role = "model";
        break;
      case "user":
        break;
      default:
        throw new HttpError(`Unknown message role: "${item.role}"`, 400);
    }
    contents.push({
      role: item.role,
      parts: item.tool_calls ? transformFnCalls(item) : await transformMsg(item),
    });
  }
  if (system_instruction) {
    if (!contents[0]?.parts.some((p) => p.text)) {
      contents.unshift({ role: "user", parts: { text: " " } });
    }
  }
  return { system_instruction, contents };
};

const transformTools = (req) => {
  let tools, tool_config;
  if (req.tools) {
    const funcs = req.tools.filter((t) => t.type === "function");
    funcs.forEach(adjustSchema);
    tools = [{ function_declarations: funcs.map((s) => s.function) }];
  }
  if (req.tool_choice) {
    const allowed_function_names =
      req.tool_choice?.type === "function" ? [req.tool_choice?.function?.name] : undefined;
    if (allowed_function_names || typeof req.tool_choice === "string") {
      tool_config = {
        function_calling_config: {
          mode: allowed_function_names ? "ANY" : req.tool_choice.toUpperCase(),
          allowed_function_names,
        },
      };
    }
  }
  return { tools, tool_config };
};

const transformRequest = async (req, isV3) => ({
  ...(await transformMessages(req.messages)),
  safetySettings,
  generationConfig: transformConfig(req, isV3),
  ...transformTools(req),
});

// ---------- 响应转换 ----------
const generateId = () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 29 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
};

const reasonsMap = { STOP: "stop", MAX_TOKENS: "length", SAFETY: "content_filter", RECITATION: "content_filter" };
const SEP = "\n\n|>";

function transformCandidates(key, cand) {
  const message = { role: "assistant", content: [] };
  let thought_signature;
  for (const part of cand.content?.parts ?? []) {
    if (part.functionCall) {
      const fc = part.functionCall;
      message.tool_calls ??= [];
      const ts = fc.thoughtSignature;
      message.tool_calls.push({
        id: fc.id ?? "call_" + generateId(),
        type: "function",
        function: { name: fc.name, arguments: JSON.stringify(fc.args) },
        extra_content: ts ? { google: { thought_signature: ts } } : undefined,
      });
    } else if (typeof part.text === "string") {
      const len = message.content.length;
      if (part.thought !== this.isThinking) {
        this.isThinking = part.thought;
        let prefix;
        if (part.thought) prefix = "<thought>\n";
        else {
          prefix = "</thought>\n\n";
          if (len) message.content[len - 1] = message.content[len - 1].trimEnd() + "\n";
          else prefix += "\n";
        }
        part.text = prefix + part.text;
      } else if (len) {
        message.content[len - 1] += SEP;
      }
      message.content.push(part.text);
      if (thought_signature && part.thoughtSignature) throw new Error("Unexpected multiple thoughtSignature");
      thought_signature = part.thoughtSignature;
    } else {
      throw new Error("Unexpected part type: " + JSON.stringify(part, 2));
    }
  }
  message.content = message.content.join("") ?? null;
  if (thought_signature) message.extra_content = { google: { thought_signature } };
  return {
    index: cand.index ?? 0,
    [key]: message,
    logprobs: null,
    finish_reason: message.tool_calls ? "tool_calls" : reasonsMap[cand.finishReason] ?? cand.finishReason,
  };
}

const notEmpty = (el) => (Object.values(el).some((v) => v !== undefined && v !== null) ? el : undefined);
const sum = (...nums) => nums.reduce((t, n) => t + (n ?? 0), 0);
const transformUsage = (data) => ({
  completion_tokens: sum(data.candidatesTokenCount, data.toolUsePromptTokenCount, data.thoughtsTokenCount),
  prompt_tokens: data.promptTokenCount,
  total_tokens: data.totalTokenCount,
  completion_tokens_details: notEmpty({
    audio_tokens: data.candidatesTokensDetails?.find((e) => e.modality === "AUDIO")?.tokenCount,
    reasoning_tokens: data.thoughtsTokenCount,
  }),
  prompt_tokens_details: notEmpty({
    audio_tokens: data.promptTokensDetails?.find((e) => e.modality === "AUDIO")?.tokenCount,
    cached_tokens: data.cacheTokensDetails?.reduce((a, e) => a + e.tokenCount, 0),
  }),
});

const checkPromptBlock = (choices, promptFeedback, key) => {
  if (choices.length) return;
  if (promptFeedback?.blockReason) {
    choices.push({ index: 0, [key]: null, finish_reason: "content_filter" });
  }
};

const processCompletionsResponse = (data, model, id) => {
  const obj = {
    id: data.responseId ?? id,
    choices: data.candidates.map(transformCandidates.bind({}, "message")),
    created: Math.floor(Date.now() / 1000),
    model: data.modelVersion ?? model,
    object: "chat.completion",
    usage: data.usageMetadata ? transformUsage(data.usageMetadata) : undefined,
  };
  if (obj.choices.length === 0) checkPromptBlock(obj.choices, data.promptFeedback, "message");
  return JSON.stringify(obj);
};

// ---------- SSE 流式解析 ----------
const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;
function parseStream(chunk, controller) {
  this.buffer += chunk;
  do {
    const match = this.buffer.match(responseLineRE);
    if (!match) break;
    controller.enqueue(match[1]);
    this.buffer = this.buffer.substring(match[0].length);
  } while (true);
}
function parseStreamFlush(controller) {
  if (this.buffer) {
    console.error("Invalid data:", this.buffer);
    controller.enqueue(this.buffer);
    this.shared.is_buffers_rest = true;
  }
}

const delimiter = "\n\n";
const sseline = (obj) => {
  obj.created = Math.floor(Date.now() / 1000);
  return "data: " + JSON.stringify(obj) + delimiter;
};
function toOpenAiStream(line, controller) {
  let data;
  try {
    data = JSON.parse(line);
    if (!data.candidates) throw new Error("Invalid completion chunk object");
  } catch (err) {
    console.error("Error parsing response:", err);
    if (!this.shared.is_buffers_rest) line = delimiter + line;
    controller.enqueue(line);
    return;
  }
  let obj;
  try {
    obj = {
      id: data.responseId ?? this.id,
      choices: data.candidates.map(transformCandidates.bind(this, "delta")),
      model: data.modelVersion ?? this.model,
      object: "chat.completion.chunk",
      usage: data.usageMetadata && this.streamIncludeUsage ? null : undefined,
    };
  } catch (err) {
    console.error(err);
    controller.enqueue("Unexpected error while handling request: " + err.message);
    controller.enqueue("\n\n" + line);
    controller.terminate();
    return;
  }
  if (checkPromptBlock(obj.choices, data.promptFeedback, "delta")) {
    controller.enqueue(sseline(obj));
    return;
  }
  const cand = obj.choices[0];
  cand.index ??= 0;
  const finish_reason = cand.finish_reason;
  cand.finish_reason = null;
  if (!this.last[cand.index]) {
    controller.enqueue(
      sseline({
        ...obj,
        choices: [{ ...cand, tool_calls: undefined, delta: { role: "assistant", content: "" } }],
      })
    );
  }
  delete cand.delta.role;
  if ("content" in cand.delta) controller.enqueue(sseline(obj));
  cand.finish_reason = finish_reason;
  if (data.usageMetadata && this.streamIncludeUsage) obj.usage = transformUsage(data.usageMetadata);
  cand.delta = {};
  this.last[cand.index] = obj;
}
function toOpenAiStreamFlush(controller) {
  if (this.last.length > 0) {
    for (const obj of this.last) controller.enqueue(sseline(obj));
    controller.enqueue("data: [DONE]" + delimiter);
  }
}

// =============================================================
// Pages 入口：export default
// env.ASSETS 是 Pages 注入的静态资源 fetcher
// =============================================================
export default {
  async fetch(request, env) {
    // CORS 预检
    if (request.method === "OPTIONS") return handleOPTIONS();

    const url = new URL(request.url);
    const { pathname } = url;

    // 错误处理
    const errHandler = (err) => {
      console.error(err);
      return new Response(err.message, fixCors({ status: err.status ?? 500 }));
    };

    try {
      // 根路径返回说明页
      if (pathname === "/" || pathname === "/index.html") {
        return new Response(INDEX_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // 路由：只处理 /v1/* 下的 OpenAI 兼容端点，其它交给静态资源
      const auth = request.headers.get("Authorization");
      const apiKey = auth?.split(" ")[1];

      const assert = (ok) => {
        if (!ok) throw new HttpError("The specified HTTP method is not allowed for the requested resource", 400);
      };

      if (pathname.endsWith("/chat/completions")) {
        assert(request.method === "POST");
        return handleCompletions(await request.json(), apiKey).catch(errHandler);
      }
      if (pathname.endsWith("/embeddings")) {
        assert(request.method === "POST");
        return handleEmbeddings(await request.json(), apiKey).catch(errHandler);
      }
      if (pathname.endsWith("/models")) {
        assert(request.method === "GET");
        return handleModels(apiKey).catch(errHandler);
      }

      // 未匹配到 API 路由：交给 Pages 静态资源（env.ASSETS）处理
      if (env && env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      throw new HttpError("404 Not Found", 404);
    } catch (err) {
      return errHandler(err);
    }
  },
};
