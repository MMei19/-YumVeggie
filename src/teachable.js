import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-wasm';
import fetch from 'node-fetch';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const MODEL_URL = process.env.TM_MODEL_URL;
const META_URL  = process.env.TM_META_URL;

// บอก TF ให้โหลดไฟล์ wasm อัตโนมัติจาก CDN (ค่า default)
tf.env().set('WASM_HAS_SIMD_SUPPORT', true); // ช่วยให้เร็วขึ้นถ้าเบราว์เซอร์/รันไทม์รองรับ

let model;
let labels;

async function ensureReady() {
  if (!model) {
    await tf.setBackend('wasm'); // ใช้ WASM เพื่อหลบ native build
    await tf.ready();
    model = await tf.loadLayersModel(MODEL_URL);
  }
  if (!labels) {
    const res = await fetch(META_URL);
    if (!res.ok) throw new Error(`โหลด metadata ไม่สำเร็จ: ${res.status}`);
    const meta = await res.json();
    labels = meta.labels || [];
  }
}

// ---- Decode helpers ----
function bufferToTensor(buf) {
  // พยายาม decode เป็น JPEG ก่อน ถ้าไม่ใช่ลอง PNG
  try {
    const { width, height, data } = jpeg.decode(buf, { useTArray: true });
    // data = RGBA → ตัด A ออก
    const rgb = tf.tensor3d(data, [height, width, 4]).slice([0, 0, 0], [height, width, 3]);
    return rgb;
  } catch {
    // try PNG
    const png = PNG.sync.read(buf);
    const { width, height, data } = png; // RGBA
    const t = tf.tensor3d(data, [height, width, 4]).slice([0, 0, 0], [height, width, 3]);
    return t;
  }
}

// Resize/Normalize → [1,224,224,3]
function preprocess(imgTensor) {
  const resized = tf.image.resizeBilinear(imgTensor, [224, 224]);
  const normalized = resized.toFloat().div(255);
  return normalized.expandDims(0);
}

export async function predictVeggie(imageBuffer) {
  await ensureReady();

  const input = tf.tidy(() => preprocess(bufferToTensor(imageBuffer)));
  const logits = model.predict(input);
  const data = await logits.data();
  input.dispose(); tf.dispose(logits);

  // หากโมเดลไม่มี softmax ในตัว ให้คำนวณเอง (ปลอดภัย)
  const max = Math.max(...data);
  const exps = Array.from(data, v => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map(v => v / sum);

  const ranked = probs
    .map((p, i) => ({ label: labels[i] || `class_${i}`, prob: p }))
    .sort((a, b) => b.prob - a.prob);

  return { label: ranked[0].label, confidences: ranked };
}
