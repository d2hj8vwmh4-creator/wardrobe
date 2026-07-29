// AI 调用层（仅 native / Capacitor 模式使用）。
// 通过 Capacitor 7 内置 CapacitorHttp（@capacitor/core）在原生层发起请求，
// 绕过浏览器 CORS（DashScope 对 WebView fetch 返回 Access-Control-Allow-Origin: null）。
//
// 【根因修复 · 导入失败】此前使用废弃插件 @capacitor-community/http@1.4.1（仅兼容
// Capacitor 3）：在 Capacitor 7 上请求未带 params 字段时原生层直接
// NullPointerException（HttpRequestHandler.setUrlParams 对 null 调 keys()），
// 所有 AI 请求全部失败 →「导入照片失败」。且其 Http.post 不支持 files multipart、
// responseType:"blob" 实际返回 base64 字符串，图像链路从未可用。
// 迁移到内置 CapacitorHttp：JSON 直接 data 传对象；multipart 用
// dataType:"formData" + type:"base64File"（原生侧 CapacitorHttpUrlConnection
// writeFormDataRequestBody 支持）；二进制响应用 responseType:"blob"（返回 base64，
// 需自行转 Blob）。
import { CapacitorHttp } from "@capacitor/core";
import { base64ToBlob } from "./env.js";

const DETECTION_PROMPT = "Identify every distinct wearable clothing item visible in this image. A photo may show one isolated garment or a person wearing several items. Return one record per actual item that should enter a wardrobe. Ignore the person's body and non-wearable background objects. For each item, include a tight bounding box around only that item using integer coordinates normalized to a 1000 by 1000 image: x and y are the top-left corner, followed by width and height. Boxes may overlap when garments overlap, but each box must focus on one distinct item. Use only these category ids: upperbody, wholebody_up, lowerbody, accessories_up, necklace, bag, shoes (其中 accessories_up 指帽子/围巾等头颈配饰，necklace 指项链，bag 指包包). Suggest a concise specific name written in Simplified Chinese (简体中文), primary hex color, optional genuinely distinct secondary hex color, and 1-4 useful lowercase detail tags (also in Simplified Chinese, e.g. 镂空、宽松、长袖).";

async function httpJson(method, url, headers, data) {
  const fn = method === "get" ? CapacitorHttp.get : CapacitorHttp.post;
  return fn({
    url,
    headers: { "Content-Type": "application/json", ...headers },
    data,
    connectTimeout: 120000,
    readTimeout: 240000,
  });
}

// CapacitorHttp 的 responseType:"blob" 返回 base64 字符串（原生 buildResponse 编码）
async function httpGetBlob(url) {
  const res = await CapacitorHttp.get({ url, responseType: "blob", connectTimeout: 120000, readTimeout: 240000 });
  if (res.status >= 400) throw new Error(`下载生成图片失败 (${res.status})`);
  const mime = res.headers?.["Content-Type"] || res.headers?.["content-type"] || "image/png";
  return base64ToBlob(String(res.data), String(mime).split(";")[0]);
}

// CapacitorHttp 对 JSON 响应自动解析为对象；容错处理字符串响应
function asJson(data) {
  if (data && typeof data === "object") return data;
  try { return JSON.parse(String(data)); } catch { return {}; }
}

function extractJson(text) {
  if (typeof text !== "string") throw new Error("空的 AI 分析结果");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("AI 分析未返回 JSON");
  return raw.slice(start, end + 1);
}

async function qwenAnalyze({ key, baseUrl, model, imageBase64, mime }) {
  const res = await httpJson("post", `${baseUrl}/chat/completions`, { Authorization: `Bearer ${key}` }, {
    model,
    messages: [{ role: "user", content: [
      { type: "text", text: `${DETECTION_PROMPT}\n\nRespond with ONLY a JSON object of the form {"items":[{"name","part","color","secondaryColor","tags","boundingBox"}]}. No markdown, no prose.` },
      { type: "image_url", image_url: { url: `data:${mime};base64,${imageBase64}` } },
    ] }],
    response_format: { type: "json_object" },
    temperature: 0.2,
  });
  const body = asJson(res.data);
  if (res.status >= 400) throw new Error(body?.error?.message || `Qwen 分析失败 (${res.status})`);
  const text = body?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Qwen 分析未返回内容");
  const parsed = JSON.parse(extractJson(text));
  if (!Array.isArray(parsed.items)) throw new Error("Qwen 分析返回了无效的衣物列表");
  return parsed.items;
}

async function openAIAnalyze({ key, baseUrl, model, imageBase64, mime }) {
  const res = await httpJson("post", `${baseUrl}/responses`, { Authorization: `Bearer ${key}` }, {
    model,
    input: [{ role: "user", content: [
      { type: "input_text", text: DETECTION_PROMPT },
      { type: "input_image", image_url: `data:${mime};base64,${imageBase64}` },
    ] }],
    text: { format: { type: "json_schema", name: "wardrobe_items", strict: true, schema: { type: "object", additionalProperties: false, properties: { items: { type: "array", minItems: 0, maxItems: 8, items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, part: { type: "string", enum: ["upperbody", "wholebody_up", "lowerbody", "accessories_up", "necklace", "bag", "shoes"] }, color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, secondaryColor: { anyOf: [{ type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, { type: "null" }] }, tags: { type: "array", items: { type: "string" }, maxItems: 4 }, boundingBox: { type: "object", additionalProperties: false, properties: { x: { type: "integer", minimum: 0, maximum: 999 }, y: { type: "integer", minimum: 0, maximum: 999 }, width: { type: "integer", minimum: 1, maximum: 1000 }, height: { type: "integer", minimum: 1, maximum: 1000 } }, required: ["x", "y", "width", "height"] } }, required: ["name", "part", "color", "secondaryColor", "tags", "boundingBox"] } } }, required: ["items"] } } },
  });
  const body = asJson(res.data);
  if (res.status >= 400) throw new Error(body?.error?.message || `OpenAI 分析失败 (${res.status})`);
  const outputText = body?.output_text || body?.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI 分析未返回结构化结果");
  const parsed = JSON.parse(outputText);
  if (!Array.isArray(parsed.items)) throw new Error("OpenAI 分析返回了无效的衣物列表");
  return parsed.items;
}

async function pollQwenTask(key, taskId, baseUrl) {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const res = await CapacitorHttp.get({ url: `${baseUrl}/api/v1/tasks/${taskId}`, headers: { Authorization: `Bearer ${key}` }, connectTimeout: 120000, readTimeout: 240000 });
    const json = asJson(res.data);
    const status = json.output?.task_status;
    if (status === "SUCCEEDED") {
      const url = json.output?.choices?.[0]?.message?.content?.find?.((part) => typeof part?.image === "string")?.image
        || json.output?.results?.[0]?.url;
      if (!url) throw new Error("Qwen 图像任务成功但未返回结果地址");
      return url;
    }
    if (status === "FAILED") throw new Error(`Qwen 图像任务失败: ${json.output?.message || json.output?.code || "未知错误"}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("Qwen 图像任务超时");
}

async function qwenImageEdit({ key, baseUrl, model, prompt, images, size }) {
  const isMultimodal = /^qwen-image/i.test(model);
  const content = [{ text: prompt }];
  for (const image of images) {
    content.push({ image: `data:${image.mime};base64,${image.base64}` });
  }
  if (isMultimodal) {
    const res = await httpJson("post", `${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`, { Authorization: `Bearer ${key}` }, {
      model,
      input: { messages: [{ role: "user", content }] },
      parameters: { size: String(size).replace("x", "*"), n: 1, prompt_extend: false, watermark: false, negative_prompt: " " },
    });
    const body = asJson(res.data);
    if (res.status >= 400) throw new Error(body?.message || body?.output?.message || `Qwen 图像生成失败 (${res.status})`);
    const imgs = (body?.output?.choices?.[0]?.message?.content || [])
      .filter((part) => typeof part?.image === "string")
      .map((part) => part.image);
    if (!imgs.length) throw new Error("Qwen 图像未返回结果地址");
    return httpGetBlob(imgs[0]);
  }
  const createRes = await httpJson("post", `${baseUrl}/api/v1/services/aigc/image-generation/generation`, { Authorization: `Bearer ${key}`, "X-DashScope-Async": "enable" }, {
    model,
    input: { messages: [{ role: "user", content }] },
    parameters: { size: String(size).replace("x", "*"), n: 1 },
  });
  const createBody = asJson(createRes.data);
  if (createRes.status >= 400) throw new Error(createBody?.message || createBody?.output?.message || `Qwen 图像任务失败 (${createRes.status})`);
  const taskId = createBody?.output?.task_id;
  if (!taskId) throw new Error("Qwen 图像任务未返回 task_id");
  const resultUrl = await pollQwenTask(key, taskId, baseUrl);
  return httpGetBlob(resultUrl);
}

async function openAIEdit({ key, baseUrl, model, prompt, images, size, background, quality }) {
  // multipart/form-data：原生侧按 type 区分 string 字段与 base64File 文件
  const form = [
    { type: "string", key: "model", value: model },
    { type: "string", key: "prompt", value: prompt },
    { type: "string", key: "size", value: String(size) },
    { type: "string", key: "quality", value: quality || "high" },
    { type: "string", key: "output_format", value: "png" },
  ];
  if (background) form.push({ type: "string", key: "background", value: background });
  images.forEach((image, index) => {
    form.push({
      type: "base64File",
      key: "image[]",
      fileName: image.name?.replace(/\.[^.]+$/, ".png") || `image-${index + 1}.png`,
      contentType: "image/png",
      value: image.base64,
    });
  });
  const res = await CapacitorHttp.post({
    url: `${baseUrl}/images/edits`,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "multipart/form-data" },
    data: form,
    dataType: "formData",
    connectTimeout: 120000,
    readTimeout: 240000,
  });
  const body = asJson(res.data);
  if (res.status >= 400) throw new Error(body?.error?.message || `OpenAI 图像失败 (${res.status})`);
  const encoded = body?.data?.[0]?.b64_json;
  if (!encoded) throw new Error("OpenAI 响应未包含图片数据");
  return base64ToBlob(encoded, "image/png");
}

export async function analyzeImage({ key, provider, visionBaseUrl, visionModel, imageBase64, mime }) {
  const baseUrl = (visionBaseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  if (provider === "qwen") return qwenAnalyze({ key, baseUrl, model: visionModel, imageBase64, mime });
  return openAIAnalyze({ key, baseUrl, model: visionModel, imageBase64, mime });
}

export async function editImage({ key, provider, visionBaseUrl, imageBaseUrl, imageModel, garmentModel, imageQuality, prompt, images, size, background }) {
  const baseUrl = (provider === "qwen" ? (imageBaseUrl || "https://dashscope.aliyuncs.com") : (visionBaseUrl || "https://api.openai.com/v1")).replace(/\/$/, "");
  const model = garmentModel || imageModel;
  if (provider === "qwen") return qwenImageEdit({ key, baseUrl, model, prompt, images, size });
  return openAIEdit({ key, baseUrl, model, prompt, images, size, background, quality: imageQuality });
}
