import 'dotenv/config';
import express from 'express';
import { middleware, Client } from '@line/bot-sdk';
import { predictVeggie } from './teachable.js';
import { getMessageBuffer } from './utils.js';
import { veggiesInfo } from './veggies.js';

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error('❌ โปรดตั้งค่า LINE_CHANNEL_ACCESS_TOKEN และ LINE_CHANNEL_SECRET ใน ENV');
  process.exit(1);
}

const app = express();
const client = new Client(config);

// Health check
app.get('/', (_req, res) => res.send('Veggie Bot on Render ✅'));

// Webhook endpoint (ต้องใช้ path นี้ใน LINE Console)
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== 'message') return;

  if (event.message.type === 'image') {
    try {
      const buf = await getMessageBuffer(client, event.message.id);
      const { label, confidences } = await predictVeggie(buf);

      const info = veggiesInfo[label];
      const confStr = confidences
        .slice(0, 3)
        .map(c => `${c.label}: ${(c.prob * 100).toFixed(1)}%`)
        .join('\n');

      let shownName = label;
      if (info?.nameTH) shownName = `${label} (${info.nameTH})`;

      let replyText = `🥬 ผักที่คาดว่าเป็น: ${shownName}\nความมั่นใจ (Top 3)\n${confStr}`;
      if (info) {
        replyText += `\n\nประโยชน์: ${info.benefit}\nเมนูแนะนำ: ${info.menu}`;
      } else {
        replyText += `\n\nℹ️ ยังไม่มีข้อมูลประโยชน์/เมนูของ "${label}" ในฐานข้อมูล\n` +
                     `พิมพ์: เพิ่มข้อมูล ${label} ประโยชน์=... เมนู=...`;
      }

      return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
    } catch (e) {
      console.error('predict error:', e);
      return client.replyMessage(event.replyToken, { type: 'text', text: 'ขออภัย วิเคราะห์ภาพไม่สำเร็จ 😢' });
    }
  }

  if (event.message.type === 'text') {
    const text = (event.message.text || '').trim();

    if (/^ช่วย|วิธีใช้|help$/i.test(text)) {
      const guide =
        `ส่งรูปผักให้บอททายชื่อ พร้อมประโยชน์และเมนู\n` +
        `หรือพิมพ์: เพิ่มข้อมูล <ชื่อผักEN> ประโยชน์=<ข้อความ> เมนู=<ข้อความ>`;
      return client.replyMessage(event.replyToken, { type: 'text', text: guide });
    }

    if (text.startsWith('เพิ่มข้อมูล ')) {
      const m = text.match(/^เพิ่มข้อมูล\s+(\S+)\s+ประโยชน์=(.+?)\s+เมนู=(.+)$/);
      if (m) {
        const nameEN = m[1];
        const benefit = m[2].trim();
        const menu = m[3].trim();
        const current = veggiesInfo[nameEN] || { nameTH: '', benefit: '', menu: '' };
        veggiesInfo[nameEN] = { ...current, benefit, menu };
        return client.replyMessage(event.replyToken, { type: 'text', text: `บันทึกข้อมูลผัก "${nameEN}" แล้ว ✅` });
      }
      return client.replyMessage(
        event.replyToken,
        { type: 'text', text: 'รูปแบบไม่ถูกต้อง ลอง: เพิ่มข้อมูล Carrot ประโยชน์=... เมนู=...' }
      );
    }

    return client.replyMessage(event.replyToken, { type: 'text', text: 'ส่งรูปผักมาได้เลย หรือพิมพ์ "ช่วย" เพื่อดูวิธีใช้' });
  }
}

const PORT = process.env.PORT || 3000;
// Render จะตั้ง HOST/IP เอง แค่ listen PORT ก็พอ
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server listening on :${PORT}`));
