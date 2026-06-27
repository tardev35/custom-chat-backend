const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const http = require('http'); 
const { Server } = require('socket.io'); 

const prisma = new PrismaClient();
const app = express();

const sharp = require('sharp');

// 🟢 สร้าง HTTP Server และเสียบ Socket.io เข้าไป
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

const fs = require('fs');
const path = require('path');
const multer = require('multer');

// 1. สร้างโฟลเดอร์ uploads สำหรับเก็บรูปภาพ
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// 2. เปิดให้หน้า React สามารถดึงรูปในโฟลเดอร์นี้ไปโชว์ได้
app.use('/uploads', express.static(uploadDir));

// 3. ตั้งค่าการเซฟไฟล์ (แก้บั๊กชื่อไฟล์มีช่องว่างให้ LINE ยอมรับ)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    // 🟢 แปลงช่องว่างและอักษรแปลกๆ ให้เป็นขีดกลาง (เช่น "My Pic.jpg" -> "My-Pic.jpg")
    const cleanFileName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '-');
    cb(null, `${Date.now()}-${cleanFileName}`); // แปะ timestamp นำหน้ากันชื่อซ้ำ
  }
});
const upload = multer({ storage: multer.memoryStorage() });

app.post('/upload-image', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  try {
    // กำจัดตัวอักษรแปลกๆ และช่องว่าง
    const cleanFileName = req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '-').split('.')[0];
    const webpFilename = `${Date.now()}-${cleanFileName}.webp`;
    const outputPath = path.join(uploadDir, webpFilename);

    // 🟢 พระเอกของเรา: Sharp บีบอัด + แปลง WebP + รีไซส์ไม่ให้เกิน 1040px (สเปก LINE)
    await sharp(req.file.buffer)
      .resize({ width: 1040, withoutEnlargement: true }) 
      .webp({ quality: 80 }) // คุณภาพ 80% (ชัดเป๊ะแต่ไฟล์เล็กจิ๋ว)
      .toFile(outputPath);

    res.json({ imageUrl: `/uploads/${webpFilename}` }); 
  } catch (error) {
    console.error("Sharp Error:", error);
    res.status(500).send("Error processing image");
  }
});

// ====================================================================
// ⚙️ [ระบบ 15 OA] บริหารจัดการช่องทางร้านค้า
// ====================================================================
const fetchLineBotProfile = async (token) => {
  try {
    const res = await axios.get('https://api.line.me/v2/bot/info', {
      headers: { Authorization: `Bearer ${token}` }
    });
    return { pictureUrl: res.data.pictureUrl, displayName: res.data.displayName };
  } catch (error) {
    return { pictureUrl: null, displayName: null };
  }
};

app.post('/channels', async (req, res) => {
  try {
    const { platform, providerId, accessToken } = req.body;
    if (!providerId || !accessToken) return res.status(400).send("ข้อมูลไม่ครบถ้วน");
    const botInfo = await fetchLineBotProfile(accessToken);
    const finalName = botInfo.displayName || req.body.name || "Unknown OA";
    const channel = await prisma.channel.create({
      data: { name: finalName, platform, providerId, accessToken, pictureUrl: botInfo.pictureUrl }
    });
    res.json({ success: true, channel });
  } catch (error) { res.status(500).send(error.message); }
});

app.get('/channels', async (req, res) => {
  try {
    const channels = await prisma.channel.findMany({ orderBy: { createdAt: 'asc' }});
    res.json(channels);
  } catch (error) { res.status(500).send(error.message); }
});

app.put('/channels/:id', async (req, res) => {
  try {
    const { name, providerId, accessToken } = req.body;
    const botInfo = await fetchLineBotProfile(accessToken); 
    const finalName = botInfo.displayName || name;
    const updated = await prisma.channel.update({
      where: { id: req.params.id },
      data: { name: finalName, providerId, accessToken, pictureUrl: botInfo.pictureUrl }
    });
    res.json(updated);
  } catch (error) { res.status(500).send(error.message); }
});

app.delete('/channels/:id', async (req, res) => {
  try {
    await prisma.channel.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) { res.status(500).send(error.message); }
});

// ====================================================================
// 💳 [ระบบคลังการ์ด] บริหารจัดการ Promotion & Flex Message
// ====================================================================
app.get('/channels/:channelId/templates', async (req, res) => {
  try {
    const templates = await prisma.cardTemplate.findMany({
      where: { channelId: req.params.channelId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(templates);
  } catch (error) { res.status(500).send(error.message); }
});

app.post('/templates', async (req, res) => {
  try {
    const { title, description, msgType, imageUrl, flexPayload, altText, channelId } = req.body;
    const newTemplate = await prisma.cardTemplate.create({
      data: { title, description, msgType, imageUrl, flexPayload, altText, channelId }
    });
    res.json({ success: true, template: newTemplate });
  } catch (error) { res.status(500).send(error.message); }
});

app.delete('/templates/:id', async (req, res) => {
  try {
    await prisma.cardTemplate.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) { res.status(500).send(error.message); }
});

// ====================================================================
// 🔑 [ระบบแอดมิน / พนักงาน]
// ====================================================================

// 1. Login (ดึงข้อมูลสิทธิ์ OA ไปให้หน้า React ด้วย)
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    // 🟢 ดึงข้อมูลช่องทาง (channels) ที่แอดมินคนนี้รับผิดชอบติดไปด้วย
    const admin = await prisma.admin.findUnique({ 
      where: { username },
      include: { channels: true } 
    });
    
    if (!admin || admin.password !== password) return res.status(401).json({ success: false, message: "Username หรือ รหัสผ่านไม่ถูกต้อง" });
    
    res.json({ 
      success: true, 
      admin: { 
        id: admin.id, name: admin.name, username: admin.username, role: admin.role, 
        channels: admin.channels // 🟢 ส่งสิทธิ์กลับไป
      } 
    });
  } catch (error) { res.status(500).send(error.message); }
});

// 2. ดึงรายชื่อพนักงานทั้งหมด (ให้โชว์ว่าดูแลสาขาไหนบ้าง)
app.get('/admins', async (req, res) => {
  try {
    const admins = await prisma.admin.findMany({ 
      select: { id: true, username: true, name: true, role: true, channels: true } // 🟢 ดึง channels
    });
    res.json(admins);
  } catch (error) { res.status(500).send(error.message); }
});

// 3. สร้างพนักงานใหม่ พร้อมผูกสิทธิ์ OA ทันที
app.post('/admins', async (req, res) => {
  try {
    const { username, password, name, role, channelIds } = req.body; // 🟢 รับ channelIds มาด้วย
    
    const newAdmin = await prisma.admin.create({ 
      data: { 
        username, password, name, role: role || 'STAFF',
        channels: {
          connect: channelIds ? channelIds.map(id => ({ id: id })) : [] // 🟢 สั่งผูกความสัมพันธ์เข้าด้วยกัน
        }
      } 
    });
    res.json({ success: true, newAdmin });
  } catch (error) { res.status(400).send("Username นี้ซ้ำ หรือมีปัญหาในการผูกสาขา"); }
});

// 4. ลบพนักงาน (ใช้ของเดิมได้เลย)
app.delete('/admins/:id', async (req, res) => {
  try {
    await prisma.admin.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) { res.status(500).send(error.message); }
});

// ====================================================================
// 🚪 [ประตูหลัก] ศูนย์รวมรับส่งข้อมูลแชทกลาง (The Dynamic Webhook Router)
// ====================================================================
app.post('/webhook', async (req, res) => {
  try {
    let userId, displayName, textContent, senderType, adminId, incomingProviderId, pictureUrl; 
    let needsActionInput = req.body.needsAction === true;
    let stateInput = req.body.state;

    // A: ข้อมูลยิงมาจากบอท n8n / React
    if (req.body.sender_type) {
      userId = req.body.line_user_id;
      displayName = req.body.display_name;
      textContent = req.body.text_content;
      senderType = req.body.sender_type.toUpperCase(); 
      adminId = req.body.admin_id; 
      incomingProviderId = req.body.provider_id; 
      pictureUrl = req.body.pictureUrl; 
    } 
    // B: ข้อความวิ่งมาจาก LINE OA จริง
    else if (req.body.events && req.body.events.length > 0) {
      const event = req.body.events[0];
      if (event.type === 'message' && event.message.type === 'text') {
        userId = event.source.userId;
        textContent = event.message.text;
        senderType = 'CUSTOMER';
        displayName = "ลูกค้า LINE";
        incomingProviderId = req.query.provider_id || req.body.provider_id;
      } else {
        return res.json({ success: true, message: "Non-text event ignored" });
      }
    }

    if (!userId || !textContent) return res.status(400).send("Missing parameters");

    // STEP 1: บันทึกข้อมูลลูกค้า
    const customer = await prisma.customer.upsert({
      where: { platformUserId: userId },
      update: {
        ...(displayName && displayName !== "ลูกค้า LINE" ? { displayName } : {}),
        ...(pictureUrl ? { pictureUrl } : {}) 
      },
      create: { platformUserId: userId, displayName: displayName || "ลูกค้า LINE", pictureUrl: pictureUrl || null }
    });

    // STEP 2: ค้นหาช่องทางแบรนด์คู่ค้า
    let targetedChannel = null;
    if (incomingProviderId) targetedChannel = await prisma.channel.findUnique({ where: { providerId: incomingProviderId } });

    // STEP 3: ตรวจสอบห้องแชทและอัปเดตสถานะ
    let conversationUpdate = { updatedAt: new Date() };

    if (stateInput === 'agent') {
      conversationUpdate.botEnabled = false; 
      conversationUpdate.needsAction = true; 
    }
    
    if (senderType === 'CUSTOMER') {
      conversationUpdate.isUnread = true;
      conversationUpdate.status = 'ACTIVE'; 
      if (targetedChannel) conversationUpdate.channelId = targetedChannel.id; 
    } else {
      conversationUpdate.isUnread = false;
      conversationUpdate.needsAction = needsActionInput;
      if (senderType === 'ADMIN' && adminId) {
        conversationUpdate.assigneeId = adminId;
        conversationUpdate.botEnabled = false; 
      }
    }

    let conversation = await prisma.conversation.findFirst({ where: { customerId: customer.id } });
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: { 
          customerId: customer.id, botEnabled: true, isUnread: senderType === 'CUSTOMER', 
          needsAction: needsActionInput, status: 'ACTIVE', channelId: targetedChannel ? targetedChannel.id : null
        }
      });
    } else {
      if (targetedChannel && !conversation.channelId) conversationUpdate.channelId = targetedChannel.id;
      conversation = await prisma.conversation.update({ where: { id: conversation.id }, data: conversationUpdate });
    }

    // คำนวณ Response Time
    let calculatedResponseTime = null;
    if (senderType === 'ADMIN') {
      const lastCustomerMessage = await prisma.message.findFirst({
        where: { conversationId: conversation.id, senderType: 'CUSTOMER' },
        orderBy: { createdAt: 'desc' }
      });
      if (lastCustomerMessage) {
        const diffMs = new Date() - new Date(lastCustomerMessage.createdAt);
        calculatedResponseTime = Math.floor(diffMs / 1000); 
      }
    }

    // STEP 4: บันทึกประวัติข้อความ
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: senderType, 
        textContent: textContent,
        adminId: senderType === 'ADMIN' ? adminId : null,
        responseTime: calculatedResponseTime,
        isInternal: senderType === 'INTERNAL_NOTE',
        aiDraftText: req.body.ai_draft_text || null,
        isDraftEdited: req.body.is_draft_edited || false
      }
    });

    // 📡 ยิง Socket.io บอกทุกจอให้อัปเดต UI ทันที
    io.emit('chatUpdate', { conversationId: conversation.id });

    // STEP 5: ยิงข้อมูลไปหาลูกค้า (LINE) ถ้าแอดมินพิมพ์
    if (senderType === 'ADMIN') {
      const currentConv = await prisma.conversation.findUnique({ where: { id: conversation.id }, include: { channel: true } });
      const dynamicToken = currentConv?.channel?.accessToken;

      if (!dynamicToken) return res.status(400).send("ยังไม่ผูกสิทธิ์ LINE OA");

      let msgType = req.body.msg_type || 'text';
      let lineMessagePayload = { type: 'text', text: textContent };

      // 🟢 [อัปเดตใหม่] ประกอบร่าง URL รูปภาพให้เต็มยศ (ป้องกันส่งไปแล้วลูกค้าไม่เห็น)
      if (msgType === 'image' && req.body.image_url) {
        const fullImageUrl = req.body.image_url.startsWith('http') 
          ? req.body.image_url 
          : `https://apiline.linedevbot.vip${req.body.image_url}`;
          
        lineMessagePayload = { 
          type: 'image', 
          originalContentUrl: fullImageUrl, 
          previewImageUrl: fullImageUrl 
        };
      } else if (msgType === 'flex' && req.body.flex_payload) {
        lineMessagePayload = { type: 'flex', altText: "🎁 มีข้อความพิเศษถึงคุณ", contents: req.body.flex_payload };
      } else if (msgType === 'carousel' && req.body.flex_payload) {
        lineMessagePayload = { type: 'flex', altText: "🎁 โปรโมชั่นพิเศษ", contents: { type: 'carousel', contents: req.body.flex_payload.contents || req.body.flex_payload } };
      }

      await axios.post('https://api.line.me/v2/bot/message/push', {
        to: userId, messages: [lineMessagePayload]
      }, {
        headers: { 'Authorization': `Bearer ${dynamicToken}`, 'Content-Type': 'application/json' }
      }).catch(err => console.error("❌ Line Push Error", err.response?.data));
    }

    res.json({ success: true, message: message, bot_enabled: conversation.botEnabled });
  } catch (error) {
    console.error("❌ Webhook Error:", error);
    res.status(500).send(error.message);
  }
});

// ====================================================================
// 🚪 [ประตูข้อมูล UI] ดึงข้อมูลรายชื่อแชทและประวัติการคุย
// ====================================================================
app.get('/conversations', async (req, res) => {
  try {
    const conversations = await prisma.conversation.findMany({
      include: {
        customer: true, channel: true, assignee: true, 
        messages: { orderBy: { createdAt: 'desc' }, take: 1 }
      }
    });

    conversations.sort((a, b) => {
      const timeA = a.messages[0] ? new Date(a.messages[0].createdAt).getTime() : new Date(a.createdAt).getTime();
      const timeB = b.messages[0] ? new Date(b.messages[0].createdAt).getTime() : new Date(b.createdAt).getTime();
      if (timeB === timeA) return a.id.localeCompare(b.id);
      return timeB - timeA; 
    });

    res.json(conversations);
  } catch (error) { res.status(500).send(error.message); }
});

app.get('/messages/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const currentConv = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (currentConv && currentConv.isUnread) {
      await prisma.conversation.update({ where: { id: conversationId }, data: { isUnread: false } });
      io.emit('chatUpdate', { conversationId: conversationId }); 
    }

    const chatHistory = await prisma.message.findMany({
      where: { conversationId: conversationId },
      orderBy: { createdAt: 'asc' },
      include: { admin: true }
    });
    res.json(chatHistory);
  } catch (error) { res.status(500).send(error.message); }
});

// 🎛️ ประตูควบคุม CRM (ยิง Socket.io ทุกครั้งที่มีการอัปเดต)
app.put('/conversations/:id/toggle-bot', async (req, res) => {
  try {
    const updated = await prisma.conversation.update({ where: { id: req.params.id }, data: { botEnabled: req.body.botEnabled } });
    io.emit('chatUpdate', { conversationId: req.params.id });
    res.json(updated);
  } catch (error) { res.status(500).send(error.message); }
});

app.put('/conversations/:id/toggle-action', async (req, res) => {
  try {
    const updated = await prisma.conversation.update({ where: { id: req.params.id }, data: { needsAction: req.body.needsAction } });
    io.emit('chatUpdate', { conversationId: req.params.id });
    res.json(updated);
  } catch (error) { res.status(500).send(error.message); }
});

app.put('/customers/:id/nickname', async (req, res) => {
  try {
    const updated = await prisma.customer.update({ where: { id: req.params.id }, data: { nickname: req.body.nickname } });
    io.emit('chatUpdate', { reloadAll: true });
    res.json(updated);
  } catch (error) { res.status(500).send(error.message); }
});

app.put('/customers/:id/tags', async (req, res) => {
  try {
    const updated = await prisma.customer.update({ where: { id: req.params.id }, data: { tags: req.body.tags } });
    io.emit('chatUpdate', { reloadAll: true });
    res.json(updated);
  } catch (error) { res.status(500).send(error.message); }
});

// ✨ AI Co-Pilot
app.post('/draft-response', async (req, res) => {
  try {
    const { conversationId } = req.body;
    const recentMessages = await prisma.message.findMany({
      where: { conversationId: conversationId },
      orderBy: { createdAt: 'desc' }, take: 10
    });
    recentMessages.reverse();
    const chatContext = recentMessages.map(m => {
      const sender = m.senderType === 'CUSTOMER' ? 'ลูกค้า' : 'แอดมิน/บอท';
      return `${sender}: ${m.textContent}`;
    }).join('\n');

    const n8nResponse = await axios.post('https://apiline.linedevbot.vip/webhook/ai-draft', {
      history: chatContext, conversationId: conversationId
    });
    res.json({ success: true, draftText: n8nResponse.data.suggestedText });
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// ====================================================================
// 📊 [ระบบ Analytics ร่างทอง] แดชบอร์ดผู้บริหาร & KPI แอดมิน (หมวดที่ 5)
// ====================================================================
app.get('/analytics', async (req, res) => {
  try {
    const { channelId } = req.query; // รับค่าสาขาจากหน้าเว็บ

    // 🟢 สร้างเงื่อนไขตัวกรอง: ถ้าเลือก ALL ก็ไม่ต้องกรอง ถ้าเลือกสาขา ก็ให้หาเฉพาะแชทของสาขานั้น
    const convFilter = channelId && channelId !== 'ALL' ? { channelId: channelId } : {};

    // 1. Bot Deflection & Cost Saving (กรองตามสาขา)
    const totalMessages = await prisma.message.count({ 
      where: { senderType: { in: ['BOT', 'ADMIN'] }, conversation: convFilter } 
    });
    const botMessages = await prisma.message.count({ 
      where: { senderType: 'BOT', conversation: convFilter } 
    });
    const adminMessages = await prisma.message.count({ 
      where: { senderType: 'ADMIN', conversation: convFilter } 
    });

    // 2. Admin Leaderboard & KPI (กรองเฉพาะข้อความที่แอดมินตอบในสาขานั้นๆ)
    const admins = await prisma.admin.findMany();
    
    const leaderboard = await Promise.all(admins.map(async (admin) => {
      const actualAdminMessages = await prisma.message.findMany({
        where: {
          adminId: admin.id,
          senderType: 'ADMIN',
          responseTime: { not: null },
          conversation: convFilter // 🔥 กรองเฉพาะแชทที่มาจาก OA ที่เลือก
        },
        select: { responseTime: true }
      });

      const answered = actualAdminMessages.length;
      const validTimes = actualAdminMessages.map(m => m.responseTime);
      const avgResponseTime = validTimes.length > 0 ? Math.floor(validTimes.reduce((a, b) => a + b, 0) / validTimes.length) : 0;
      
      let performance = '⚡ สปีดเทพมาก';
      let colorClass = 'text-green-600 bg-green-50';
      
      if (answered === 0) {
        performance = '💤 สแตนด์บาย';
        colorClass = 'text-gray-500 bg-gray-50';
      } else if (avgResponseTime > 300) {
        performance = '🔴 ช้าเกินเกณฑ์';
        colorClass = 'text-red-600 bg-red-50';
      } else if (avgResponseTime > 60) {
        performance = '🟢 ปกติ';
        colorClass = 'text-blue-600 bg-blue-50';
      }

      return { id: admin.id, name: admin.name || admin.username, answered, avgResponseTime, performance, colorClass };
    }));

    leaderboard.sort((a, b) => b.answered - a.answered);

    // 3. Hourly Traffic Load (กรองกราฟตามสาขา + แก้บั๊ก Timezone ไทย UTC+7)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentMessages = await prisma.message.findMany({
      where: { createdAt: { gte: yesterday }, senderType: 'CUSTOMER', conversation: convFilter },
      select: { createdAt: true }
    });
    
    const hourlyData = Array(24).fill(0);
    recentMessages.forEach(m => {
      // 🟢 ดึงชั่วโมงแบบมาตรฐานโลก แล้วบวก 7 ชั่วโมงให้เป็นเวลาไทย
      const utcDate = new Date(m.createdAt);
      const thaiHour = (utcDate.getUTCHours() + 7) % 24; 
      hourlyData[thaiHour]++;
    });

    // 4. Manual Override Tracking (กรองเคสคุมมือตามสาขา)
    const manualOverrides = await prisma.conversation.findMany({
      where: { botEnabled: false, ...convFilter },
      include: { channel: true, assignee: true, customer: true }
    });

    // 5. ดึงรายชื่อสาขา (OA) ทั้งหมดส่งไปทำ Dropdown ตัวกรองบนหน้าเว็บ
    const channels = await prisma.channel.findMany({ select: { id: true, name: true } });

    res.json({
      channels, // ส่งกลับไปให้หน้าเว็บสร้างปุ่ม Dropdown
      deflection: { total: totalMessages, bot: botMessages, admin: adminMessages },
      leaderboard,
      hourlyData,
      manualOverrides
    });
  } catch (error) {
    console.error("Analytics Error:", error);
    res.status(500).send(error.message);
  }
});

// ====================================================================
// 🧼 [API ล้างสถิติเวอร์ชันผ่านฉลุย] รีเซ็ตข้อมูลเวลาตอบของแอดมินทุกคนเพื่อเริ่มทดสอบใหม่
// ====================================================================
app.post('/analytics/reset-my-kpi', async (req, res) => {
  try {
    const { adminId } = req.body;

    // 🟢 [ปรับลอจิกใจดี] ถ้าหน้าบ้านส่ง ID มาไม่สมบูรณ์ (เป็น undefined จนเกิด Error 400)
    // ให้ระบบทำการรีเซ็ตเคลียร์ค่าความเร็ว (responseTime) ของทุกแอดมินในระบบให้เป็นศูนย์ เพื่อเริ่มนับหนึ่งใหม่พร้อมกันเลยครับ
    if (!adminId) {
      await prisma.message.updateMany({
        where: { senderType: 'ADMIN' },
        data: { responseTime: null }
      });
      return res.json({ 
        success: true, 
        message: "ล้างสถิติเวลาของแอดมินทั้งหมดในระบบให้เป็นศูนย์แล้ว เพื่อเริ่มทดสอบใหม่ครับ!" 
      });
    }

    // เจาะจงล้างเฉพาะแอดมินที่ส่ง ID มาตรงๆ
    await prisma.message.updateMany({
      where: {
        adminId: adminId,
        senderType: 'ADMIN'
      },
      data: {
        responseTime: null
      }
    });

    res.json({ 
      success: true, 
      message: "ล้างสถิติเวลาของคุณเรียบร้อยแล้ว!" 
    });
  } catch (error) {
    console.error("Reset KPI Error:", error);
    res.status(500).send(error.message);
  }
});

// ====================================================================
// 🚨 [DANGER ZONE] API ล้างกระดานแชททั้งหมดเพื่อเริ่มนับ 0 ใหม่ (เวอร์ชันเบราว์เซอร์)
// ====================================================================
app.get('/system/hard-reset-chats', async (req, res) => {
  try {
    const deletedMessages = await prisma.message.deleteMany({});
    const deletedConversations = await prisma.conversation.deleteMany({});
    const deletedCustomers = await prisma.customer.deleteMany({});

    res.json({ 
      success: true, 
      message: "ล้างกระดานข้อมูลแชททั้งหมดเรียบร้อยแล้ว! KPI กลับไปเริ่มต้นที่ 0",
      stats: {
        messagesDeleted: deletedMessages.count,
        conversationsDeleted: deletedConversations.count,
        customersDeleted: deletedCustomers.count
      }
    });
  } catch (error) {
    console.error("Hard Reset Error:", error);
    res.status(500).send(error.message);
  }
});

// ====================================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 เอนจิ้นคุมพลังหลังบ้านร่างทองคำ V.Final (Real-time Socket.io + Full URL Image Fix) พร้อมรบที่พอร์ต ${PORT}`);
});