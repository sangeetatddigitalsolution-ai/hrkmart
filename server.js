require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
let axios; try { axios = require('axios'); } catch(e) { axios = null; }

const app = express();
app.use(cors());
app.use(express.json());

// ─── NATIVE FETCH POLYFILL (fixes "Cannot find package 'node-fetch'") ─────────
// Node 18+ has globalThis.fetch built-in. For older Node versions we fall back
// to a tiny https/http wrapper — NO extra npm package required.
// Safe JSON helper — never throws on empty/non-JSON body
function safeParseJSON(text) {
  const t = (text || '').trim();
  if (!t) throw new Error('Empty response from Selloship API (no body returned)');
  try { return JSON.parse(t); }
  catch(e) { throw new Error('Selloship returned non-JSON response: ' + t.slice(0, 300)); }
}

const nativeFetch = globalThis.fetch
  ? (url, opts = {}) => globalThis.fetch(url, opts).then(res => {
      const origJson = res.json.bind(res);
      const origText = res.text.bind(res);
      // Wrap .json() so it gives a readable error instead of "Unexpected end of JSON"
      res.json = async () => {
        const text = await origText();
        return safeParseJSON(text);
      };
      return res;
    })
  : function nativeFetch(url, opts = {}) {
      return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const lib = parsedUrl.protocol === 'https:' ? https : http;
        const bodyStr = opts.body || '';
        const headers = { ...opts.headers };
        if (bodyStr && !headers['Content-Length']) {
          headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }
        const options = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: opts.method || 'GET',
          headers
        };
        const req = lib.request(options, (res) => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const ok = res.statusCode >= 200 && res.statusCode < 300;
            resolve({
              ok,
              status: res.statusCode,
              json: () => Promise.resolve(safeParseJSON(raw)),
              text: () => Promise.resolve(raw)
            });
          });
        });
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
      });
    };

// ─── MONGOOSE CONNECT ─────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ─── SCHEMAS ──────────────────────────────────────────────────────────────────
const orderSchema = new mongoose.Schema({
  name: String, phone: String, address: String, pincode: String,
  city: String, state: String, product: String, productName: String,
  productId: String, quantity: { type: Number, default: 1 }, size: String,
  price: Number, totalAmount: Number, addressScore: { type: Number, default: 0 },
  status: { type: String, enum: ['new','confirmed','shipped','delivered','cancelled'], default: 'new' },
  shippedAt: { type: Date },
  awb: { type: String, default: null },
  courierName: { type: String, default: null },
  shippingLabel: { type: String, default: null },
  shippingMode: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});

const productSchema = new mongoose.Schema({
  name: String, description: String, price: Number, mrp: Number,
  images: [String], benefits: [String], ingredients: String, howToUse: String,
  stock: { type: Number, default: 100 }, active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const settingSchema = new mongoose.Schema({
  metaPixel: String, backendUrl: String,
  selloshipUsername: String, selloshipPassword: String
});

const testimonialSchema = new mongoose.Schema({
  name: String, location: String, text: String, rating: { type: Number, default: 5 },
  videoUrl: String, avatarLetter: String, active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const adminTokenSchema = new mongoose.Schema({
  token: { type: String, unique: true, index: true },
  createdAt: { type: Date, default: Date.now, expires: 86400 }
});

const Order       = mongoose.model('Order',       orderSchema);
const Product     = mongoose.model('Product',     productSchema);
const Setting     = mongoose.model('Setting',     settingSchema);
const Testimonial = mongoose.model('Testimonial', testimonialSchema);
const AdminToken  = mongoose.model('AdminToken',  adminTokenSchema);

// ─── ADMIN AUTH MIDDLEWARE ─────────────────────────────────────────────────────
async function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = (auth.startsWith('Bearer ') ? auth.slice(7) : '') || req.query.token || '';
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    const found = await AdminToken.findOne({ token });
    if (!found) return res.status(401).json({ success: false, error: 'Session expired — please login again' });
    next();
  } catch(e) { return res.status(500).json({ success: false, error: 'Auth error' }); }
}

function calcAddressScore(addr, pincode, city, state) {
  let score = 0;
  if (addr && addr.trim().length > 10) score += 40;
  else if (addr && addr.trim().length > 5) score += 20;
  if (pincode && /^\d{6}$/.test(pincode)) score += 20;
  if (city && city.trim().length > 1) score += 20;
  if (state && state.trim().length > 1) score += 20;
  return score;
}

// ─── SELLOSHIP ────────────────────────────────────────────────────────────────
const SELLO_BASE = 'https://selloship.com/api/lock_actvs/channels';
let _selloToken = null, _selloTokenExpiry = null;

// Selloship HTTP helper — uses axios if available, falls back to nativeFetch
// axios is more reliable for APIs that need exact Content-Length handling
async function selloPost(url, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = token;
  console.log('[Selloship] POST', url);
  console.log('[Selloship] payload:', JSON.stringify(body).slice(0, 400));
  try {
    let data;
    if (axios) {
      const res = await axios.post(url, body, { headers, timeout: 30000 });
      data = res.data;
    } else {
      const bodyStr = JSON.stringify(body);
      headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();
      const res = await nativeFetch(url, { method: 'POST', headers, body: bodyStr });
      const raw = await res.text();
      if (!raw.trim()) throw new Error('Empty response from Selloship (HTTP ' + res.status + ')');
      data = safeParseJSON(raw);
    }
    console.log('[Selloship] response:', JSON.stringify(data).slice(0, 400));
    return data;
  } catch(e) {
    // axios wraps the response in e.response
    if (e.response) {
      const body = e.response.data;
      const msg = (typeof body === 'object' ? JSON.stringify(body) : String(body)).slice(0, 300);
      throw new Error('Selloship HTTP ' + e.response.status + ': ' + msg);
    }
    throw e;
  }
}

async function getSelloToken(username, password) {
  if (_selloToken && _selloTokenExpiry && Date.now() < _selloTokenExpiry) return _selloToken;
  const data = await selloPost(SELLO_BASE + '/authToken', { username, password }, null);
  if (data.status !== 'SUCCESS') throw new Error('Selloship auth failed: ' + JSON.stringify(data));
  _selloToken = data.token;
  _selloTokenExpiry = Date.now() + 55 * 60 * 1000;
  console.log('[Selloship] Auth OK, token cached 55 min');
  return _selloToken;
}

async function selloCreateWaybill(token, payload) {
  const data = await selloPost(SELLO_BASE + '/waybill', payload, token);
  if (data.status !== 'SUCCESS') throw new Error('Waybill failed: ' + (data.message || JSON.stringify(data)) + (data.reason ? ' | reason: ' + data.reason : ''));
  return data;
}

async function selloGetStatus(token, awbNumbers) {
  const query = awbNumbers.join(',');
  const data = await selloPost(SELLO_BASE + '/waybillDetails?waybills=' + encodeURIComponent(query), {}, token);
  if (data.Status !== 'SUCCESS') throw new Error('Status fetch failed: ' + JSON.stringify(data));
  return data.waybillDetails;
}

async function selloCancelWaybill(token, awb) {
  const data = await selloPost(SELLO_BASE + '/cancel', { waybill: awb }, token);
  if (data.status !== 'SUCCESS') throw new Error('Cancel failed: ' + data.message);
  return data;
}

async function getSelloCredentials() {
  const s = await Setting.findOne();
  if (!s?.selloshipUsername || !s?.selloshipPassword)
    throw new Error('Selloship credentials not configured. Go to Settings → Selloship to connect.');
  return { username: s.selloshipUsername, password: s.selloshipPassword };
}

function buildWaybillPayload(order, extra = {}) {
  // Field names exactly as Selloship API expects them
  // Both camelCase and snake_case variants included for compatibility
  const totalAmt = Number(order.totalAmount || order.price || 0);
  return {
    // Consignee (receiver) details
    name: order.name,
    mobile: order.phone,
    address: order.address,
    city: order.city,
    state: order.state,
    pincode: order.pincode,
    // Also send alternate field name variants
    consigneeName: order.name,
    consigneeMobile: order.phone,
    consigneePhone: order.phone,
    consigneeAddress: order.address,
    consigneeAddress1: order.address,
    consigneeCity: order.city,
    consigneeState: order.state,
    consigneePincode: String(order.pincode),
    // Shipment details
    productName: order.productName || 'Product',
    productDesc: order.productName || 'Product',
    product: order.productName || 'Product',
    quantity: order.quantity || 1,
    qty: order.quantity || 1,
    weight: 500,        // grams
    length: 15,
    breadth: 12,
    height: 8,
    // Payment
    paymentMode: 'COD',
    payment_mode: 'COD',
    codAmount: totalAmt,
    collectableAmount: totalAmt,
    cod_amount: totalAmt,
    declaredValue: totalAmt,
    // Order reference
    orderNumber: order._id.toString(),
    orderRefNumber: order._id.toString(),
    order_id: order._id.toString(),
    ...extra
  };
}

// ─── SELLOSHIP DEBUG ENDPOINT ────────────────────────────────────────────────
// Lets you test what Selloship actually accepts without creating a real order
app.post('/api/debug/selloship-probe', requireAdmin, async (req, res) => {
  try {
    const { username, password } = await getSelloCredentials();
    // Step 1: test auth
    _selloToken = null; _selloTokenExpiry = null;
    const token = await getSelloToken(username, password);
    // Step 2: send minimal waybill and return raw response  
    const testPayload = {
      name: 'Test Customer', mobile: '9999999999', phone: '9999999999',
      address: 'Test Address Line 1', city: 'Mumbai', state: 'Maharashtra',
      pincode: '400001', consigneeName: 'Test Customer', consigneeMobile: '9999999999',
      consigneeAddress1: 'Test Address', consigneeCity: 'Mumbai',
      consigneeState: 'Maharashtra', consigneePincode: '400001',
      productName: 'Test Product', productDesc: 'Test Product',
      quantity: 1, qty: 1, weight: 500, length: 15, breadth: 12, height: 8,
      paymentMode: 'COD', payment_mode: 'COD', codAmount: 599,
      collectableAmount: 599, declaredValue: 599,
      orderNumber: 'TEST-' + Date.now(), orderRefNumber: 'TEST-' + Date.now()
    };
    const headers = { 'Content-Type': 'application/json', 'Authorization': token };
    let rawResponse = '';
    let statusCode = 0;
    try {
      if (axios) {
        const r = await axios.post(SELLO_BASE + '/waybill', testPayload, { headers, timeout: 30000 });
        rawResponse = JSON.stringify(r.data);
        statusCode = r.status;
      } else {
        const bodyStr = JSON.stringify(testPayload);
        const r = await nativeFetch(SELLO_BASE + '/waybill', { method:'POST', headers:{ ...headers,'Content-Length': Buffer.byteLength(bodyStr).toString() }, body: bodyStr });
        rawResponse = await r.text();
        statusCode = r.status;
      }
    } catch(e) {
      rawResponse = e.response ? JSON.stringify(e.response.data) : e.message;
      statusCode = e.response?.status || 0;
    }
    res.json({ success: true, authOk: true, waybillHttpStatus: statusCode, waybillRawResponse: rawResponse, payloadSent: testPayload });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── PUBLIC ROUTES ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', brand: 'VacuKart', ts: Date.now() }));

app.post('/api/orders', async (req, res) => {
  try {
    const { name, phone, address, pincode, city, state, product, productName, productId, quantity, size, price, totalAmount } = req.body;
    if (!name || !name.trim()) return res.json({ success: false, error: 'Name is required' });
    if (!phone || !/^\d{10}$/.test(phone.trim())) return res.json({ success: false, error: 'Valid 10-digit phone is required' });
    if (!address || !address.trim()) return res.json({ success: false, error: 'Address is required' });
    if (!pincode || !/^\d{6}$/.test(pincode.trim())) return res.json({ success: false, error: 'Valid 6-digit pincode is required' });
    if (!city || !city.trim()) return res.json({ success: false, error: 'City is required — valid pincode needed' });
    if (!state || !state.trim()) return res.json({ success: false, error: 'State is required — valid pincode needed' });
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const dup = await Order.findOne({ phone: phone.trim(), createdAt: { $gte: tenMinAgo } });
    if (dup) return res.json({ success: false, duplicate: true, error: 'Aapka order pehle se place ho chuka hai!' });
    const addressScore = calcAddressScore(address, pincode, city, state);
    const order = new Order({ name, phone, address, pincode, city, state, product, productName, productId, quantity: quantity||1, size, price, totalAmount, addressScore });
    await order.save();
    res.json({ success: true, orderId: order._id });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/products', async (req, res) => {
  try { const products = await Product.find({ active: true }); res.json({ success: true, products }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});

// Serve compact pincode DB to frontend
app.get('/pc.json', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400'); // cache 1 day
  res.sendFile(path.join(__dirname, 'pc.json'), (err) => {
    if (err) res.status(404).json({ error: 'pc.json not found' });
  });
});


const fs   = require('fs');
const path = require('path');

// ─── PINCODE DB: merge pincode_db.json + pincode_data.json ───────────────────
let _pcDB = {};
try {
  _pcDB = JSON.parse(fs.readFileSync(path.join(__dirname,'pincode_db.json'),'utf8'));
  console.log(`✅ pincode_db.json loaded: ${Object.keys(_pcDB).length} entries`);
} catch(e) { console.warn('⚠️  pincode_db.json not found'); }
try {
  const _pcData = JSON.parse(fs.readFileSync(path.join(__dirname,'pincode_data.json'),'utf8'));
  let added = 0;
  for (const [pin, entry] of Object.entries(_pcData)) {
    if (!_pcDB[pin] && entry.state) { _pcDB[pin] = { city: entry.city, state: entry.state }; added++; }
  }
  console.log(`✅ pincode_data.json merged: +${added} entries (total: ${Object.keys(_pcDB).length})`);
} catch(e) { console.warn('⚠️  pincode_data.json not found'); }

// Runtime cache: pincodes fetched from external API this session
const _pincodeCache = new Map();

// India pincode first-2-digits → state (covers all postal circles)
const _PIN_STATE = {
  '11':'Delhi','12':'Haryana','13':'Haryana','14':'Punjab','15':'Punjab','16':'Punjab',
  '17':'Himachal Pradesh','18':'Jammu & Kashmir','19':'Jammu & Kashmir',
  '20':'Uttar Pradesh','21':'Uttar Pradesh','22':'Uttar Pradesh','23':'Uttar Pradesh',
  '24':'Uttar Pradesh','25':'Uttar Pradesh','26':'Uttar Pradesh','27':'Uttar Pradesh',
  '28':'Uttar Pradesh','29':'Uttar Pradesh',
  '30':'Rajasthan','31':'Rajasthan','32':'Rajasthan','33':'Rajasthan','34':'Rajasthan','35':'Rajasthan',
  '36':'Gujarat','37':'Gujarat','38':'Gujarat','39':'Gujarat',
  '40':'Maharashtra','41':'Maharashtra','42':'Maharashtra','43':'Maharashtra','44':'Maharashtra',
  '45':'Madhya Pradesh','46':'Madhya Pradesh','47':'Madhya Pradesh','48':'Madhya Pradesh',
  '49':'Chhattisgarh',
  '50':'Andhra Pradesh','51':'Andhra Pradesh','52':'Andhra Pradesh','53':'Andhra Pradesh',
  '54':'Andhra Pradesh','55':'Andhra Pradesh',
  '56':'Karnataka','57':'Karnataka','58':'Karnataka','59':'Karnataka',
  '60':'Tamil Nadu','61':'Tamil Nadu','62':'Tamil Nadu','63':'Tamil Nadu','64':'Tamil Nadu','65':'Tamil Nadu',
  '66':'Kerala','67':'Kerala','68':'Kerala','69':'Kerala',
  '70':'West Bengal','71':'West Bengal','72':'West Bengal','73':'West Bengal','74':'West Bengal',
  '75':'Odisha','76':'Odisha','77':'Odisha',
  '78':'Assam','79':'Northeast India',
  '80':'Bihar','81':'Bihar','84':'Bihar','85':'Bihar',
  '82':'Jharkhand','83':'Jharkhand',
  '86':'Odisha',
  '87':'West Bengal',
  '90':'Armed Forces','91':'Armed Forces','92':'Armed Forces','93':'Armed Forces','94':'Armed Forces',
};

// postalpincode.in SSL cert expired. postpincode.in is the working replacement.
// Normalizes both responses to same format.
function _fetchPincodeAPI(pin) {
  return new Promise((resolve, reject) => {
    const req = require('https').request({
      hostname: 'www.postpincode.in',
      path: `/api/getCityName.php?pincode=${pin}`,
      method: 'GET',
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (Array.isArray(data) && data.length > 0 && data[0].State) {
            const d = data[0];
            resolve([{ Status: 'Success', PostOffice: [{
              Name: d.City || d.District || '',
              District: d.District || '',
              State: d.State
            }]}]);
          } else {
            reject(new Error('No data'));
          }
        } catch(e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

app.get('/api/pincode/:pin', async (req, res) => {
  const pin = String(req.params.pin).replace(/\D/g,'');
  if (pin.length !== 6) return res.json([{ Status: 'Error', Message: 'Invalid pin' }]);

  // Layer 1: local DB (~0ms)
  const local = _pcDB[pin];
  if (local?.state) {
    return res.json([{ Status: 'Success', PostOffice: [{
      Name: local.city || local.district || local.postOffice || '',
      District: local.district || local.city || '',
      State: local.state
    }]}]);
  }

  // Layer 2: in-memory session cache (sub-ms for repeat queries)
  const cached = _pincodeCache.get(pin);
  if (cached) {
    return res.json([{ Status: 'Success', PostOffice: [{
      Name: cached.city || cached.district || cached.postOffice || '',
      District: cached.district || cached.city || '',
      State: cached.state
    }]}]);
  }

  // Layer 3: external API with 5s timeout
  try {
    const data = await _fetchPincodeAPI(pin);
    if (Array.isArray(data) && data[0]?.Status === 'Success' && data[0]?.PostOffice?.length > 0) {
      const po = data[0].PostOffice[0];
      _pincodeCache.set(pin, { city: po.District || po.Name || '', state: po.State || '', district: po.District || '', postOffice: po.Name || '' });
      return res.json(data);
    }
  } catch(e) {
    console.warn(`[Pincode] API fail for ${pin}: ${e.message}`);
  }

  // Layer 4: state-prefix guess — at minimum returns state so form can proceed
  const guessedState = _PIN_STATE[pin.slice(0,2)];
  if (guessedState) {
    return res.json([{ Status: 'Success', PostOffice: [{ Name: '', District: '', State: guessedState }], _partial: true }]);
  }

  // Layer 5: absolute fallback
  return res.json([{ Status: 'Error', Message: 'Pincode not found' }]);
});

app.get('/api/meta', async (req, res) => {
  try { const s = await Setting.findOne(); res.json({ success: true, metaPixel: s?.metaPixel || '' }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/testimonials', async (req, res) => {
  try { const testimonials = await Testimonial.find({ active: true }).sort({ createdAt: -1 }); res.json({ success: true, testimonials }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── LIVE VISITORS ─────────────────────────────────────────────────────────────
const visitorPings = new Map();
app.post('/api/visitors/ping', (req, res) => {
  const { sessionId, page } = req.body;
  if (!sessionId) return res.json({ success: false });
  visitorPings.set(sessionId, { lastPing: Date.now(), page: page || '/' });
  const now = Date.now();
  for (const [id, v] of visitorPings) { if (now - v.lastPing > 45000) visitorPings.delete(id); }
  res.json({ success: true });
});
app.get('/api/visitors/live', requireAdmin, (req, res) => {
  const now = Date.now();
  for (const [id, v] of visitorPings) { if (now - v.lastPing > 45000) visitorPings.delete(id); }
  res.json({ success: true, count: visitorPings.size });
});

// ─── ADMIN LOGIN ───────────────────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    const token = 'vk_admin_' + Date.now() + '_' + crypto.randomBytes(16).toString('hex');
    try { await AdminToken.create({ token }); res.json({ success: true, token }); }
    catch(e) { res.json({ success: false, error: 'Login failed: ' + e.message }); }
  } else {
    res.json({ success: false, error: 'Invalid credentials' });
  }
});

app.post('/api/admin/logout', requireAdmin, async (req, res) => {
  const token = req.headers['authorization'].slice(7);
  await AdminToken.deleteOne({ token });
  res.json({ success: true });
});

// ─── ORDERS ────────────────────────────────────────────────────────────────────
app.get('/api/orders', requireAdmin, async (req, res) => {
  try {
    const { status, search, from, to, page = 1, limit = 50 } = req.query;
    let query = {};
    if (status && status !== 'all') query.status = status;
    if (search) query.$or = [{ name: new RegExp(search,'i') },{ phone: new RegExp(search,'i') },{ city: new RegExp(search,'i') }];
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23,59,59,999); query.createdAt.$lte = d; }
    }
    const skip = (parseInt(page)-1) * parseInt(limit);
    const total = await Order.countDocuments(query);
    const orders = await Order.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit));
    res.json({ success: true, orders, total, page: parseInt(page), pages: Math.ceil(total/parseInt(limit)) });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── SHIPPED ORDERS ONLY ⭐ NEW ───────────────────────────────────────────
app.get('/api/orders/shipped', requireAdmin, async (req, res) => {
  try {
    const { search, from, to, page = 1, limit = 50 } = req.query;
    let query = { status: { $in: ['shipped', 'delivered'] } };
    if (search) query.$or = [
      { name: new RegExp(search,'i') },
      { phone: new RegExp(search,'i') },
      { city: new RegExp(search,'i') },
      { awb: new RegExp(search,'i') }
    ];
    if (from || to) {
      query.shippedAt = {};
      if (from) query.shippedAt.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23,59,59,999); query.shippedAt.$lte = d; }
    }
    const skip = Math.max(0, (parseInt(page)-1) * parseInt(limit));
    const total = await Order.countDocuments(query);
    const orders = await Order.find(query).sort({ shippedAt: -1 }).skip(skip).limit(parseInt(limit));
    res.json({ success: true, orders, total, page: parseInt(page), pages: Math.ceil(total/parseInt(limit)) });
  } catch(e) { res.json({ success: false, error: e.message }); }
});
app.get('/api/orders/export/csv', requireAdmin, async (req, res) => {
  try {
    const { from, to, status, ids } = req.query;
    let query = {};
    if (ids) { const idList = ids.split(',').filter(Boolean); query._id = { $in: idList }; }
    else {
      if (status && status !== 'all') query.status = status;
      if (from || to) {
        query.createdAt = {};
        if (from) query.createdAt.$gte = new Date(from);
        if (to) { const d = new Date(to); d.setHours(23,59,59,999); query.createdAt.$lte = d; }
      }
    }
    const orders = await Order.find(query).sort({ createdAt: -1 });
    const headers = ['Order ID','Name','Phone','Address','Pincode','City','State','Product','Qty','Amount','Addr Score','Status','AWB','Courier','Shipping Mode','Shipped At','Date'];
    const rows = orders.map(o => [
      o._id, o.name, o.phone, '"'+(o.address||'').replace(/"/g,'""')+'"',
      o.pincode, o.city, o.state, o.productName, o.quantity, o.totalAmount,
      o.addressScore||0, o.status, o.awb||'', o.courierName||'', o.shippingMode||'',
      o.shippedAt ? new Date(o.shippedAt).toLocaleString('en-IN') : '',
      new Date(o.createdAt).toLocaleString('en-IN')
    ]);
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="vaidyakart-orders.csv"');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(csv);
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Bulk status change
app.put('/api/orders/bulk/status', requireAdmin, async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!ids?.length) return res.json({ success: false, error: 'No IDs provided' });
    const validStatuses = ['new','confirmed','shipped','delivered','cancelled'];
    if (!validStatuses.includes(status)) return res.json({ success: false, error: 'Invalid status' });
    const updateData = { status };
    if (status === 'shipped') updateData.shippedAt = new Date();
    const result = await Order.updateMany({ _id: { $in: ids } }, { $set: updateData });
    res.json({ success: true, updated: result.modifiedCount });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Bulk ship via Selloship
app.post('/api/orders/bulk/ship-selloship', requireAdmin, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids?.length) return res.json({ success: false, error: 'No IDs provided' });
    const { username, password } = await getSelloCredentials();
    const selloToken = await getSelloToken(username, password);
    const orders = await Order.find({ _id: { $in: ids } });
    const results = [];
    for (const order of orders) {
      try {
        const wbData = await selloCreateWaybill(selloToken, buildWaybillPayload(order));
        await Order.findByIdAndUpdate(order._id, {
          status: 'shipped', shippedAt: new Date(),
          awb: wbData.waybill, courierName: wbData.courierName || '',
          shippingLabel: wbData.shippingLabel || '', shippingMode: 'selloship'
        });
        results.push({ orderId: order._id, success: true, awb: wbData.waybill, courier: wbData.courierName });
      } catch(err) {
        results.push({ orderId: order._id, success: false, error: err.message });
      }
    }
    res.json({ success: true, results, successCount: results.filter(r=>r.success).length, failCount: results.filter(r=>!r.success).length });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Bulk ship manually
app.post('/api/orders/bulk/ship-manual', requireAdmin, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids?.length) return res.json({ success: false, error: 'No IDs provided' });
    const result = await Order.updateMany({ _id: { $in: ids } }, { $set: { status: 'shipped', shippedAt: new Date(), shippingMode: 'manual' } });
    res.json({ success: true, updated: result.modifiedCount });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Single ship via Selloship
app.post('/api/orders/:id/ship-selloship', requireAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.json({ success: false, error: 'Order not found' });
    const { username, password } = await getSelloCredentials();
    const selloToken = await getSelloToken(username, password);
    const wbData = await selloCreateWaybill(selloToken, buildWaybillPayload(order, req.body));
    const updated = await Order.findByIdAndUpdate(req.params.id, {
      status: 'shipped', shippedAt: new Date(),
      awb: wbData.waybill, courierName: wbData.courierName || '',
      shippingLabel: wbData.shippingLabel || '', shippingMode: 'selloship'
    }, { new: true });
    res.json({ success: true, awb: wbData.waybill, courierName: wbData.courierName, shippingLabel: wbData.shippingLabel, order: updated });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Single manual ship
app.post('/api/orders/:id/ship-manual', requireAdmin, async (req, res) => {
  try {
    const { awb, courierName } = req.body;
    const updated = await Order.findByIdAndUpdate(req.params.id, {
      status: 'shipped', shippedAt: new Date(),
      awb: awb || null, courierName: courierName || null, shippingMode: 'manual'
    }, { new: true });
    if (!updated) return res.json({ success: false, error: 'Order not found' });
    res.json({ success: true, order: updated });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// AWB tracking status
app.get('/api/orders/:id/awb-status', requireAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order?.awb) return res.json({ success: false, error: 'No AWB for this order' });
    const { username, password } = await getSelloCredentials();
    const selloToken = await getSelloToken(username, password);
    const details = await selloGetStatus(selloToken, [order.awb]);
    res.json({ success: true, details });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Cancel AWB
app.post('/api/orders/:id/cancel-awb', requireAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order?.awb) return res.json({ success: false, error: 'No AWB found' });
    const { username, password } = await getSelloCredentials();
    const selloToken = await getSelloToken(username, password);
    const result = await selloCancelWaybill(selloToken, order.awb);
    res.json({ success: true, result });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Edit order fields
app.put('/api/orders/:id', requireAdmin, async (req, res) => {
  try {
    const allowed = ['name','phone','address','pincode','city','state','productName','quantity','size','price','totalAmount'];
    const updateData = {};
    for (const key of allowed) { if (req.body[key] !== undefined) updateData[key] = req.body[key]; }
    if (updateData.address || updateData.pincode || updateData.city || updateData.state) {
      const order = await Order.findById(req.params.id);
      const addr = updateData.address || order.address;
      const pin = updateData.pincode || order.pincode;
      const city = updateData.city || order.city;
      const state = updateData.state || order.state;
      updateData.addressScore = calcAddressScore(addr, pin, city, state);
    }
    const updated = await Order.findByIdAndUpdate(req.params.id, { $set: updateData }, { new: true });
    if (!updated) return res.json({ success: false, error: 'Order not found' });
    res.json({ success: true, order: updated });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.put('/api/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const updateData = { status };
    if (status === 'shipped') updateData.shippedAt = new Date();
    await Order.findByIdAndUpdate(req.params.id, updateData);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.delete('/api/orders/:id', requireAdmin, async (req, res) => {
  try { await Order.findByIdAndDelete(req.params.id); res.json({ success: true }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── PRODUCTS ──────────────────────────────────────────────────────────────────
app.get('/api/products/all', requireAdmin, async (req, res) => {
  try { const products = await Product.find(); res.json({ success: true, products }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});
app.post('/api/products', requireAdmin, async (req, res) => {
  try { const p = new Product(req.body); await p.save(); res.json({ success: true, product: p }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});
app.put('/api/products/:id', requireAdmin, async (req, res) => {
  try { const p = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true }); res.json({ success: true, product: p }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});
app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  try { await Product.findByIdAndDelete(req.params.id); res.json({ success: true }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── STATS ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    let dateQuery = {};
    if (from || to) {
      dateQuery.createdAt = {};
      if (from) dateQuery.createdAt.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23,59,59,999); dateQuery.createdAt.$lte = d; }
    }
    const [totalOrders, newOrders, confirmedOrders, shippedOrders, deliveredOrders, cancelledOrders, revenueData, latestOrders] = await Promise.all([
      Order.countDocuments(dateQuery),
      Order.countDocuments({ ...dateQuery, status: 'new' }),
      Order.countDocuments({ ...dateQuery, status: 'confirmed' }),
      Order.countDocuments({ ...dateQuery, status: 'shipped' }),
      Order.countDocuments({ ...dateQuery, status: 'delivered' }),
      Order.countDocuments({ ...dateQuery, status: 'cancelled' }),
      Order.aggregate([{ $match: { ...dateQuery, status: { $ne: 'cancelled' } } }, { $group: { _id: null, total: { $sum: '$totalAmount' } } }]),
      Order.find(Object.keys(dateQuery).length ? dateQuery : {}).sort({ createdAt: -1 }).limit(10)
    ]);
    const revenue = revenueData[0]?.total || 0;
    const chartData = await Order.aggregate([
      { $match: dateQuery },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 }, revenue: { $sum: '$totalAmount' } } },
      { $sort: { _id: 1 } }, { $limit: 30 }
    ]);
    let avgOrderIntervalMin = null;
    const recentOrders = await Order.find(dateQuery).sort({ createdAt: 1 }).select('createdAt').limit(200);
    if (recentOrders.length >= 2) {
      let totalMs = 0;
      for (let i = 1; i < recentOrders.length; i++) totalMs += new Date(recentOrders[i].createdAt) - new Date(recentOrders[i-1].createdAt);
      avgOrderIntervalMin = Math.round(totalMs / (recentOrders.length - 1) / 60000);
    }
    res.json({ success: true, totalOrders, newOrders, confirmedOrders, shippedOrders, deliveredOrders, cancelledOrders, revenue, chartData, latestOrders, avgOrderIntervalMin });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── SETTINGS ──────────────────────────────────────────────────────────────────
app.get('/api/settings', requireAdmin, async (req, res) => {
  try {
    const s = await Setting.findOne();
    res.json({
      success: true,
      metaPixel: s?.metaPixel || '',
      backendUrl: s?.backendUrl || '',
      selloshipUsername: s?.selloshipUsername || '',
      selloshipConnected: !!(s?.selloshipUsername && s?.selloshipPassword)
    });
  } catch(e) { res.json({ success: false, error: e.message }); }
});
app.post('/api/meta', requireAdmin, async (req, res) => {
  try {
    const { metaPixel } = req.body;
    let s = await Setting.findOne();
    if (s) { s.metaPixel = metaPixel; await s.save(); } else { s = await Setting.create({ metaPixel }); }
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});
app.post('/api/settings', requireAdmin, async (req, res) => {
  try {
    const { metaPixel, backendUrl, selloshipUsername, selloshipPassword } = req.body;
    let s = await Setting.findOne();
    if (s) {
      if (metaPixel !== undefined) s.metaPixel = metaPixel;
      if (backendUrl !== undefined) s.backendUrl = backendUrl;
      if (selloshipUsername !== undefined) s.selloshipUsername = selloshipUsername;
      if (selloshipPassword !== undefined) s.selloshipPassword = selloshipPassword;
      await s.save();
    } else {
      s = await Setting.create({ metaPixel, backendUrl, selloshipUsername, selloshipPassword });
    }
    if (selloshipUsername || selloshipPassword) { _selloToken = null; _selloTokenExpiry = null; }
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/settings/test-selloship', requireAdmin, async (req, res) => {
  try {
    const { username, password } = req.body;
    _selloToken = null; _selloTokenExpiry = null;
    const token = await getSelloToken(username, password);
    if (token) res.json({ success: true, message: 'Selloship connected successfully!' });
    else res.json({ success: false, error: 'Could not get token' });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── TESTIMONIALS ──────────────────────────────────────────────────────────────
app.get('/api/testimonials/all', requireAdmin, async (req, res) => {
  try { const testimonials = await Testimonial.find().sort({ createdAt: -1 }); res.json({ success: true, testimonials }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});
app.post('/api/testimonials', requireAdmin, async (req, res) => {
  try { const t = new Testimonial(req.body); await t.save(); res.json({ success: true, testimonial: t }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});
app.put('/api/testimonials/:id', requireAdmin, async (req, res) => {
  try { const t = await Testimonial.findByIdAndUpdate(req.params.id, req.body, { new: true }); res.json({ success: true, testimonial: t }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});
app.delete('/api/testimonials/:id', requireAdmin, async (req, res) => {
  try { await Testimonial.findByIdAndDelete(req.params.id); res.json({ success: true }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});

// Selloship webhook — register this URL with Selloship dashboard
app.post('/api/shipping/webhook', async (req, res) => {
  try {
    const { waybillDetails, Status } = req.body;
    if (Status !== 'SUCCESS' || !waybillDetails?.waybill) return res.status(400).json({ error: 'Invalid payload' });
    const { waybill, currentStatus } = waybillDetails;
    const statusMap = { 'Delivered': 'delivered', 'Cancelled': 'cancelled', 'RTO': 'cancelled' };
    const ourStatus = statusMap[currentStatus];
    if (ourStatus) await Order.findOneAndUpdate({ awb: waybill }, { status: ourStatus });
    res.json({ received: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/seed', async (req, res) => {
  try {
    const count = await Product.countDocuments();
    if (count === 0) {
      await Product.create({
        name: '3-in-1 Vacuum Cleaner', description: 'VacuKart Portable 3-in-1 Vacuum Cleaner — cordless, rechargeable, home + car + crevice cleaning.',
        price: 499, mrp: 1299, images: [],
        benefits: ['12000PA strong suction power','Cordless — 30 min battery backup','Home + Car + Crevice — 3-in-1 use','Lightweight & portable (~400g)','Low noise motor','Washable reusable filter'],
        ingredients: '12000PA suction motor, 2000mAh rechargeable battery, home brush head, car nozzle, crevice tool, washable HEPA-style filter, USB-C charging, transparent easy-empty dustbin.',
        howToUse: 'USB-C se 2–3 hours full charge karein. Zaroorat ke hisaab se attachment lagayein (home/car/crevice). Power button dabakar use karein.',
        stock: 200, active: true
      });
      res.json({ success: true, message: 'Seeded' });
    } else { res.json({ success: true, message: 'Products already exist' }); }
  } catch(e) { res.json({ success: false, error: e.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log('🚀 VacuKart server running on port ' + PORT);
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_URL || 'https://YOUR-BACKEND-URL.onrender.com';
  setInterval(async () => {
    try { await nativeFetch(SELF_URL + '/'); console.log('✅ Keep-alive ping [' + new Date().toISOString() + ']'); }
    catch(e) { console.warn('⚠️ Keep-alive ping failed:', e.message); }
  }, 5 * 60 * 1000);
});
