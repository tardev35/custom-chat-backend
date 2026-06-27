const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const http = require('http'); 
const { Server } = require('socket.io'); 

const prisma = new PrismaClient();
const app = express();

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

// 3. ตั้งค่าการเซฟไฟล์
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

app.post('/upload-image', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");
  res.json({ imageUrl: `/uploads/${req.file.filename}` }); 
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
// 🔑 [ระบบแอดมิน] ตรวจสอบสิทธิ์และล็อกอิน (Authentication)
// ====================================================================
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await prisma.admin.findUnique({ where: { username } });
    if (!admin || admin.password !== password) return res.status(401).json({ success: false, message: "Username หรือ รหัสผ่านไม่ถูกต้อง" });
    res.json({ success: true, admin: { id: admin.id, name: admin.name, username: admin.username, role: admin.role } });
  } catch (error) { res.status(500).send(error.message); }
});

app.get('/admins', async (req, res) => {
  try {
    const admins = await prisma.admin.findMany({ select: { id: true, username: true, name: true, role: true }});
    res.json(admins);
  } catch (error) { res.status(500).send(error.message); }
});

app.post('/admins', async (req, res) => {
  try {
    const { username, password, name, role } = req.body;
    const newAdmin = await prisma.admin.create({ data: { username, password, name, role: role || 'STAFF' } });
    res.json({ success: true, newAdmin });
  } catch (error) { res.status(400).send("Username นี้ซ้ำกับในระบบครับ"); }
});

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
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 เอนจิ้นคุมพลังหลังบ้านร่างทองคำ V.Final (Real-time Socket.io + Full URL Image Fix) พร้อมรบที่พอร์ต ${PORT}`);
});