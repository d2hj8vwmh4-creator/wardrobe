// AI 调用层（仅 native / Capacitor 模式使用）。
// 通过 @capacitor-community/http 在原生层发起请求，绕过浏览器 CORS（DashScope 对 WebView fetch 返回 Access-Control-Allow-Origin: null）。
// 复刻 import-job-api.mjs 中 qwenAnalyze / openAIAnalyze / qwenImageEdit / openAIEdit 的语义。
import { Http } from "@capacitor-community/http";
import { base64ToBlob } from "./env.js";

const DETECTION_PROMPT = "Identify every distinct wearable clothing item visible in this image. A photo may show one isolated garment or a person wearing several items. Return one record per actual item that should enter a wardrobe. Ignore the person's body and non-wearable background objects. For each item, include a tight bounding box around only that item using integer coordinates normalized to a 1000 by 1000 image: x and y are the top-left corner, followed by width and height. Boxes may overlap when garments overlap, but each box must focus on one distinct item. Use only these category ids: upperbody, wholebody_up, lowerbody, accessories_up, necklace, bag, shoes (其中 accessories_up 指帽子/围巾等头颈配饰，necklace 指项链，bag 指包包). Suggest a concise specific name written in Simplified Chinese (简体中文), primary hex color, optional genuinely distinct secondary hex color, and 1-4 useful lowercase detail tags (also in Simplified Chinese, e.g. 镂空、宽松、长袖).";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

async function httpJson(method, url, headers, data) {
  return Http[method]({
    url,
    headers: { "Content-Type": "application/json", ...headers },
    data,
    connectTimeout: 120000,
    readTimeout: 240000,
  });
}

async function httpGetBlob(url) {
  const res = await Http.get({ url, responseType: "blob", readTimeout: 240000 });
  return res.data;
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
  if (res.status >= 400) throw new Error(res.data?.error?.message || `Qwen 分析失败 (${res.status})`);
  const text = res.data?.choices?.[0]?.message?.content;
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
  if (res.status >= 400) throw new Error(res.data?.error?.message || `OpenAI 分析失败 (${res.status})`);
  const outputText = res.data?.output_text || res.data?.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI 分析未返回结构化结果");
  const parsed = JSON.parse(outputText);
  if (!Array.isArray(parsed.items)) throw new Error("OpenAI 分析返回了无效的衣物列表");
  return parsed.items;
}

async function pollQwenTask(key, taskId, baseUrl) {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const res = await Http.get({ url: `${baseUrl}/api/v1/tasks/${taskId}`, headers: { Authorization: `Bearer ${key}` }, readTimeout: 240000 });
    const json = res.data || {};
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
    if (res.status >= 400) throw new Error(res.data?.message || res.data?.output?.message || `Qwen 图像生成失败 (${res.status})`);
    const imgs = (res.data?.output?.choices?.[0]?.message?.content || [])
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
  if (createRes.status >= 400) throw new Error(createRes.data?.message || createRes.data?.output?.message || `Qwen 图像任务失败 (${createRes.status})`);
  const taskId = createRes.data?.output?.task_id;
  if (!taskId) throw new Error("Qwen 图像任务未返回 task_id");
  const resultUrl = await pollQwenTask(key, taskId, baseUrl);
  return httpGetBlob(resultUrl);
}

async function openAIEdit({ key, baseUrl, model, prompt, images, size, background, quality }) {
  const data = {
    model,
    prompt,
    size,
    quality: quality || "high",
    output_format: "png",
  };
  if (background) data.background = background;
  const files = images.map((image, index) => ({
    name: "image[]",
    filename: image.name?.replace(/\.[^.]+$/, ".png") || `image-${index + 1}.png`,
    contentType: "image/png",
    data: image.base64,
  }));
  const res = await Http.post({
    url: `${baseUrl}/images/edits`,
    headers: { Authorization: `Bearer ${key}` },
    data,
    files,
    connectTimeout: 120000,
    readTimeout: 240000,
  });
  if (res.status >= 400) throw new Error(res.data?.error?.message || `OpenAI 图像失败 (${res.status})`);
  const encoded = res.data?.data?.[0]?.b64_json;
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
