import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';
import bcrypt from 'bcryptjs';
import PDFDocument from 'pdfkit';
import fontBytes from './backend/fonts/NotoSans.ttf';

const app = new Hono();
const cookieName = 'eb_session';
const clean = v => String(v ?? '').trim();
const num = v => Number.isFinite(Number(v)) ? Number(v) : NaN;
const uid = () => crypto.randomUUID();
const units = new Set(['gr','kg','ml','litres','piece']);
const cookie = (c) => {
  const raw = c.req.header('Cookie') || '';
  const item = raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='));
  return item ? decodeURIComponent(item.slice(cookieName.length+1)) : '';
};
const json = (c, data, status=200) => c.json(data,status);
async function body(c){ try{return await c.req.json()}catch{return {}} }
async function current(c, role) {
  const token = cookie(c) || (c.req.header('Authorization')||'').replace(/^Bearer\s+/i,'');
  if(!token) return {error:'Please sign in.',status:401};
  let payload;
  try { payload=await verify(token,c.env.JWT_SECRET); } catch { return {error:'Session expired. Please sign in again.',status:401}; }
  const u=await c.env.DB.prepare('SELECT id,username,role,shop_id,active FROM users WHERE id=?').bind(payload.sub).first();
  if(!u || Number(u.active)!==1) return {error:'This account is disabled. Contact the administrator.',status:403};
  if(role && u.role!==role) return {error:'Not authorized.',status:403};
  if(u.role==='customer'){
    const shop=await c.env.DB.prepare('SELECT active FROM shops WHERE id=?').bind(u.shop_id).first();
    if(!shop || Number(shop.active)!==1) return {error:'This shop service is temporarily disabled.',status:403};
  }
  return {user:u};
}
async function auth(c,role){const r=await current(c,role);return r.error?json(c,{error:r.error},r.status):r.user}
app.get('/api/health',c=>json(c,{ok:true,service:'EasyBill Cloudflare Worker'}));
// One-time first administrator setup. Configure SETUP_SECRET as a Worker secret,
// call this once, then remove/rotate SETUP_SECRET after the admin is created.
app.post('/api/setup/admin',async c=>{
  const b=await body(c);
  if(!c.env.SETUP_SECRET || c.req.header('X-Setup-Secret')!==c.env.SETUP_SECRET) return json(c,{error:'Setup authorization failed.'},403);
  const exists=await c.env.DB.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").first();
  if(exists) return json(c,{error:'An administrator already exists. Setup is closed.'},409);
  const username=clean(b.username),password=String(b.password||'');
  if(username.length<3 || !/^[a-zA-Z0-9._-]+$/.test(username) || password.length<12) return json(c,{error:'Use a valid username (3+ characters) and password (12+ characters).'},400);
  const id=uid();
  try { await c.env.DB.prepare("INSERT INTO users(id,username,password_hash,role,shop_id,active) VALUES(?,?,?,'admin',NULL,1)").bind(id,username,await bcrypt.hash(password,12)).run(); }
  catch(e){ if(String(e.message).includes('UNIQUE')) return json(c,{error:'That username already exists.'},409); throw e; }
  return json(c,{ok:true,message:'First administrator created. Sign in at /admin.html.'},201);
});
app.post('/api/auth/login',async c=>{
  const b=await body(c), username=clean(b.username), password=String(b.password||''), portal=clean(b.portal);
  if(!username||!password)return json(c,{error:'Enter username and password.'},400);
  const u=await c.env.DB.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').bind(username).first();
  if(!u || !(await bcrypt.compare(password,u.password_hash)))return json(c,{error:'Invalid username or password.'},401);
  if((portal==='admin'&&u.role!=='admin')||(portal==='customer'&&u.role!=='customer'))return json(c,{error:'Use the correct login website.'},403);
  if(Number(u.active)!==1)return json(c,{error:'This service is temporarily disabled. Contact the administrator.'},403);
  if(u.role==='customer'){const sh=await c.env.DB.prepare('SELECT active FROM shops WHERE id=?').bind(u.shop_id).first();if(!sh||Number(sh.active)!==1)return json(c,{error:'This shop service is temporarily disabled.'},403);}
  const token=await sign({sub:u.id,role:u.role,shopId:u.shop_id||null,username:u.username,exp:Math.floor(Date.now()/1000)+28800},c.env.JWT_SECRET);
  c.header('Set-Cookie',`${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`);
  return json(c,{ok:true,user:{username:u.username,role:u.role}});
});
app.post('/api/auth/logout',c=>{c.header('Set-Cookie',`${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);return json(c,{ok:true});});
app.get('/api/me',async c=>{const u=await auth(c);if(!u||u instanceof Response)return u;let shop=null;if(u.role==='customer')shop=await c.env.DB.prepare('SELECT id,shop_name,owner_name,phone,address,gstin FROM shops WHERE id=?').bind(u.shop_id).first();return json(c,{user:{username:u.username,role:u.role},shop});});

app.get('/api/admin/customers',async c=>{
 const u=await auth(c,'admin');if(!u||u instanceof Response)return u;
 const r=await c.env.DB.prepare(`SELECT u.id,u.username,u.active,u.created_at,s.id shop_id,s.shop_name,s.owner_name,s.phone,s.address,s.gstin,s.active shop_active,
 (SELECT COUNT(*) FROM bills b WHERE b.shop_id=s.id) bill_count
 FROM users u JOIN shops s ON s.id=u.shop_id WHERE u.role='customer' ORDER BY u.created_at DESC`).all();
 return json(c,{customers:r.results});
});
app.post('/api/admin/customers',async c=>{
 const u=await auth(c,'admin');if(!u||u instanceof Response)return u;
 const b=await body(c), username=clean(b.username),password=String(b.password||''),shopName=clean(b.shopName),ownerName=clean(b.ownerName);
 if(username.length<3||password.length<12||!shopName)return json(c,{error:'Username must be 3+ characters, password 12+ characters, and shop name is required.'},400);
 if(!/^[a-zA-Z0-9._-]+$/.test(username))return json(c,{error:'Username may contain letters, numbers, dot, underscore and hyphen only.'},400);
 const shopId=uid(),userId=uid();
 try{
  await c.env.DB.batch([
   c.env.DB.prepare('INSERT INTO shops(id,shop_name,owner_name,phone,address,gstin,active) VALUES(?,?,?,?,?,?,1)').bind(shopId,shopName,ownerName,clean(b.phone),clean(b.address),clean(b.gstin)),
   c.env.DB.prepare("INSERT INTO users(id,username,password_hash,role,shop_id,active) VALUES(?,?,?,'customer',?,1)").bind(userId,username,await bcrypt.hash(password,12),shopId)
  ]);
 }catch(e){if(String(e.message).includes('UNIQUE'))return json(c,{error:'That username already exists.'},409);throw e;}
 return json(c,{ok:true,customer:{id:userId,username,shopId,shopName,active:1,bill_count:0}},201);
});
app.patch('/api/admin/customers/:id/status',async c=>{
 const u=await auth(c,'admin');if(!u||u instanceof Response)return u;
 const b=await body(c),active=b.active===true?1:b.active===false?0:null;if(active===null)return json(c,{error:'active must be true or false.'},400);
 const target=await c.env.DB.prepare("SELECT id,shop_id FROM users WHERE id=? AND role='customer'").bind(c.req.param('id')).first();
 if(!target)return json(c,{error:'Customer not found.'},404);
 await c.env.DB.batch([c.env.DB.prepare('UPDATE users SET active=? WHERE id=?').bind(active,target.id),c.env.DB.prepare('UPDATE shops SET active=? WHERE id=?').bind(active,target.shop_id)]);
 return json(c,{ok:true,active:!!active});
});
app.get('/api/admin/cleanup-shops',async c=>{const u=await auth(c,'admin');if(!u||u instanceof Response)return u;const r=await c.env.DB.prepare('SELECT id,shop_name FROM shops ORDER BY shop_name COLLATE NOCASE').all();const p=await c.env.DB.prepare("SELECT setting_value FROM app_settings WHERE setting_key='delete_data_pin_hash'").first();return json(c,{shops:r.results,pinConfigured:!!p});});
app.post('/api/admin/delete-data-pin',async c=>{const u=await auth(c,'admin');if(!u||u instanceof Response)return u;const b=await body(c),pin=String(b.pin||'');if(!/^\d{6,12}$/.test(pin))return json(c,{error:'PIN must contain 6 to 12 digits.'},400);const old=await c.env.DB.prepare("SELECT setting_value FROM app_settings WHERE setting_key='delete_data_pin_hash'").first();if(old&&(!b.currentPin||!(await bcrypt.compare(String(b.currentPin),old.setting_value))))return json(c,{error:'Current security PIN is incorrect.'},403);const hash=await bcrypt.hash(pin,12);await c.env.DB.prepare("INSERT INTO app_settings(setting_key,setting_value) VALUES('delete_data_pin_hash',?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value").bind(hash).run();return json(c,{ok:true,message:old?'Security PIN updated.':'Security PIN created.'});});
app.post('/api/admin/delete-old-data',async c=>{const u=await auth(c,'admin');if(!u||u instanceof Response)return u;const b=await body(c),{shop_id,from_date,to_date,pin,deleteBills,deleteProducts}=b;if(!shop_id||!/^\d{4}-\d{2}-\d{2}$/.test(String(from_date||''))||!/^\d{4}-\d{2}-\d{2}$/.test(String(to_date||''))||from_date>to_date)return json(c,{error:'Choose a shop and a valid date range.'},400);const ph=await c.env.DB.prepare("SELECT setting_value FROM app_settings WHERE setting_key='delete_data_pin_hash'").first();if(!ph)return json(c,{error:'Set a deletion security PIN before deleting data.'},400);if(!(await bcrypt.compare(String(pin||''),ph.setting_value)))return json(c,{error:'Security PIN is incorrect.'},403);if(!deleteBills&&!deleteProducts)return json(c,{error:'Select at least one type of data to delete.'},400);let billsDeleted=0,itemsDeleted=0,productsDeleted=0;const stmts=[];if(deleteBills){const found=await c.env.DB.prepare("SELECT id FROM bills WHERE shop_id=? AND date(created_at)>=date(?) AND date(created_at)<=date(?)").bind(shop_id,from_date,to_date).all();billsDeleted=found.results.length;for(const x of found.results){const n=await c.env.DB.prepare('SELECT COUNT(*) n FROM bill_items WHERE bill_id=?').bind(x.id).first();itemsDeleted+=Number(n?.n||0);stmts.push(c.env.DB.prepare('DELETE FROM bill_items WHERE bill_id=?').bind(x.id),c.env.DB.prepare('DELETE FROM bills WHERE id=? AND shop_id=?').bind(x.id,shop_id));}}if(deleteProducts){const found=await c.env.DB.prepare("SELECT id FROM products WHERE shop_id=? AND date(created_at)>=date(?) AND date(created_at)<=date(?)").bind(shop_id,from_date,to_date).all();productsDeleted=found.results.length;for(const x of found.results)stmts.push(c.env.DB.prepare('DELETE FROM products WHERE id=? AND shop_id=?').bind(x.id,shop_id));}if(stmts.length)await c.env.DB.batch(stmts);return json(c,{ok:true,shop_id,from_date,to_date,billsDeleted,itemsDeleted,productsDeleted,message:'Selected records deleted.'});});

app.get('/api/shop',async c=>{const u=await auth(c,'customer');if(!u||u instanceof Response)return u;const s=await c.env.DB.prepare('SELECT id,shop_name,owner_name,phone,address,gstin FROM shops WHERE id=? AND active=1').bind(u.shop_id).first();if(!s)return json(c,{error:'Shop is disabled.'},403);return json(c,{shop:s});});
app.put('/api/shop',async c=>{const u=await auth(c,'customer');if(!u||u instanceof Response)return u;const b=await body(c),name=clean(b.shop_name);if(!name)return json(c,{error:'Shop name is required.'},400);await c.env.DB.prepare('UPDATE shops SET shop_name=?,owner_name=?,phone=?,address=?,gstin=? WHERE id=?').bind(name,clean(b.owner_name),clean(b.phone),clean(b.address),clean(b.gstin),u.shop_id).run();return json(c,{ok:true});});

app.get('/api/customer-accounts',async c=>{const u=await auth(c,'customer');if(!u||u instanceof Response)return u;const r=await c.env.DB.prepare('SELECT id,name,phone,balance,notes,created_at,updated_at FROM customer_accounts WHERE shop_id=? ORDER BY name COLLATE NOCASE').bind(u.shop_id).all();return json(c,{accounts:r.results});});
app.post('/api/customer-accounts',async c=>{const u=await auth(c,'customer');if(!u||u instanceof Response)return u;const b=await body(c),name=clean(b.name),phone=clean(b.phone),notes=clean(b.notes),balance=num(b.balance);if(!name||!Number.isFinite(balance)||balance<0)return json(c,{error:'Enter a customer name and a balance amount of 0 or more.'},400);const idv=uid();await c.env.DB.prepare('INSERT INTO customer_accounts(id,shop_id,name,phone,balance,notes) VALUES(?,?,?,?,?,?)').bind(idv,u.shop_id,name,phone,balance,notes).run();return json(c,{ok:true,account:{id:idv,name,phone,balance,notes}},201);});
app.put('/api/customer-accounts/:id',async c=>{const u=await auth(c,'customer');if(!u||u instanceof Response)return u;const b=await body(c),name=clean(b.name),phone=clean(b.phone),notes=clean(b.notes),balance=num(b.balance);if(!name||!Number.isFinite(balance)||balance<0)return json(c,{error:'Enter a customer name and a balance amount of 0 or more.'},400);const r=await c.env.DB.prepare('UPDATE customer_accounts SET name=?,phone=?,balance=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=?').bind(name,phone,balance,notes,c.req.param('id'),u.shop_id).run();if(!r.meta.changes)return json(c,{error:'Customer account not found.'},404);return json(c,{ok:true});});
app.delete('/api/customer-accounts/:id',async c=>{const u=await auth(c,'customer');if(!u||u instanceof Response)return u;const r=await c.env.DB.prepare('DELETE FROM customer_accounts WHERE id=? AND shop_id=?').bind(c.req.param('id'),u.shop_id).run();if(!r.meta.changes)return json(c,{error:'Customer account not found.'},404);return json(c,{ok:true});});

app.get('/api/products',async c=>{const u=await auth(c,'customer');if(!u||u instanceof Response)return u;const r=await c.env.DB.prepare('SELECT id,name,sku,category,price,stock,unit,gst FROM products WHERE shop_id=? ORDER BY name').bind(u.shop_id).all();return json(c,{products:r.results});});
app.post('/api/products',async c=>{const u=await auth(c,'customer');if(!u||u instanceof Response)return u;const b=await body(c),name=clean(b.name),sku=clean(b.sku),category=clean(b.category)||'General',price=num(b.price),stock=num(b.stock),gst=num(b.gst||0),unit=clean(b.unit);if(!name||!sku||!units.has(unit)||!Number.isFinite(price)||price<0||!Number.isFinite(stock)||stock<0||!Number.isFinite(gst)||gst<0||gst>100)return json(c,{error:'Check product name, SKU, unit, price, stock and GST.'},400);const idv=uid();try{await c.env.DB.prepare('INSERT INTO products(id,shop_id,name,sku,category,price,stock,unit,gst) VALUES(?,?,?,?,?,?,?,?,?)').bind(idv,u.shop_id,name,sku,category,price,stock,unit,gst).run();}catch(e){if(String(e.message).includes('UNIQUE'))return json(c,{error:'SKU already exists in this shop.'},409);throw e;}return json(c,{ok:true,id:idv},201);});
app.put('/api/products/:id',async c=>{const u=await auth(c,'customer');if(!u||u instanceof Response)return u;const b=await body(c),name=clean(b.name),sku=clean(b.sku),category=clean(b.category)||'General',price=num(b.price),stock=num(b.stock),gst=num(b.gst||0),unit=clean(b.unit);if(!name||!sku||!units.has(unit)||!Number.isFinite(price)||price<0||!Number.isFinite(stock)||stock<0||!Number.isFinite(gst)||gst<0||gst>100)return json(c,{error:'Check product fields.'},400);const r=await c.env.DB.prepare('UPDATE products SET name=?,sku=?,category=?,price=?,stock=?,unit=?,gst=? WHERE id=? AND shop_id=?').bind(name,sku,category,price,stock,unit,gst,c.req.param('id'),u.shop_id).run();if(!r.meta.changes)return json(c,{error:'Product not found in this shop.'},404);return json(c,{ok:true});});
app.delete('/api/products/:id',async c=>{const u=await auth(c,'customer');if(!u||u instanceof Response)return u;const r=await c.env.DB.prepare('DELETE FROM products WHERE id=? AND shop_id=?').bind(c.req.param('id'),u.shop_id).run();if(!r.meta.changes)return json(c,{error:'Product not found in this shop.'},404);return json(c,{ok:true});});

app.get('/api/bills',async c=>{const u=await auth(c,'customer');if(!u||u instanceof Response)return u;const r=await c.env.DB.prepare('SELECT * FROM bills WHERE shop_id=? ORDER BY created_at DESC').bind(u.shop_id).all();const bills=[];for(const b of r.results){const it=await c.env.DB.prepare('SELECT product_name name,sku,quantity qty,unit,unit_price price,gst_rate gst,line_total FROM bill_items WHERE bill_id=?').bind(b.id).all();bills.push({...b,items:it.results});}return json(c,{bills});});
app.post('/api/bills',async c=>{const u=await auth(c,'customer');if(!u||u instanceof Response)return u;const b=await body(c),customer_name=clean(b.customer_name)||'Walk-in customer',customer_phone=clean(b.customer_phone),payment_method=clean(b.payment_method)||'Cash',items=b.items;if(!Array.isArray(items)||!items.length)return json(c,{error:'Add at least one product.'},400);const shop=await c.env.DB.prepare('SELECT * FROM shops WHERE id=? AND active=1').bind(u.shop_id).first();if(!shop)return json(c,{error:'Shop is disabled.'},403);const billId=uid(),invoiceNo='EB-'+Date.now().toString().slice(-9);let subtotal=0,gstTotal=0,normalized=[];for(const line of items){const q=num(line.quantity);if(!Number.isFinite(q)||q<=0)return json(c,{error:'Invalid item quantity.'},400);const p=await c.env.DB.prepare('SELECT id,name,sku,price,stock,unit,gst FROM products WHERE id=? AND shop_id=?').bind(clean(line.product_id),u.shop_id).first();if(!p)return json(c,{error:'A selected product does not belong to this shop.'},400);if(Number(p.stock)<q)return json(c,{error:`Insufficient stock for ${p.name}.`},400);const price=line.price===undefined?Number(p.price):num(line.price);if(!Number.isFinite(price)||price<0)return json(c,{error:'Invalid price.'},400);const total=price*q,base=total/(1+Number(p.gst)/100);subtotal+=base;gstTotal+=total-base;normalized.push({product_id:p.id,name:p.name,sku:p.sku,qty:q,unit:p.unit,price,gst:Number(p.gst),lineTotal:total,stock:Number(p.stock)});}
const stmts=[c.env.DB.prepare('INSERT INTO bills(id,shop_id,invoice_no,customer_name,customer_phone,payment_method,subtotal,gst_total,total,snapshot_shop_name,snapshot_address,snapshot_phone,snapshot_gstin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(billId,u.shop_id,invoiceNo,customer_name,customer_phone,payment_method,subtotal,gstTotal,subtotal+gstTotal,shop.shop_name,shop.address,shop.phone,shop.gstin)];for(const i of normalized){stmts.push(c.env.DB.prepare('UPDATE products SET stock=stock-? WHERE id=? AND shop_id=? AND stock>=?').bind(i.qty,i.product_id,u.shop_id,i.qty));stmts.push(c.env.DB.prepare('INSERT INTO bill_items(id,bill_id,product_id,product_name,sku,quantity,unit,unit_price,gst_rate,line_total) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(uid(),billId,i.product_id,i.name,i.sku,i.qty,i.unit,i.price,i.gst,i.lineTotal));}await c.env.DB.batch(stmts);return json(c,{ok:true,bill:{id:billId,invoice_no:invoiceNo,customer_name,customer_phone,payment_method,subtotal,gst_total:gstTotal,total:subtotal+gstTotal,created_at:new Date().toISOString(),shop_name:shop.shop_name,address:shop.address,shop_phone:shop.phone,gstin:shop.gstin,items:normalized}},201);});

async function makePdf(c,idv,requestBody={}){
 const u=await auth(c,'customer');if(!u||u instanceof Response)return u;
 const b=await c.env.DB.prepare('SELECT * FROM bills WHERE id=? AND shop_id=?').bind(idv,u.shop_id).first();if(!b)return json(c,{error:'Invoice not found.'},404);
 const items=await c.env.DB.prepare('SELECT product_name,sku,quantity,unit,unit_price,gst_rate,line_total FROM bill_items WHERE bill_id=?').bind(b.id).all();
 const format=['a4','a5','thermal80','thermal58'].includes(requestBody.print_format)?requestBody.print_format:'a4';
 const size=format==='a5'?'A5':format==='thermal80'?[226,900]:format==='thermal58'?[164,900]:'A4';
 const margin=format.startsWith('thermal')?8:32;
 const doc=new PDFDocument({size,margin,bufferPages:true});
 const chunks=[];doc.on('data',x=>chunks.push(x));
 const finished=new Promise((resolve,reject)=>{doc.on('end',()=>resolve(new Blob(chunks,{type:'application/pdf'})));doc.on('error',reject);});
 try{doc.font(Buffer.from(fontBytes));}catch{doc.font('Helvetica');}
 const left=doc.page.margins.left,right=doc.page.width-doc.page.margins.right,w=right-left;
 const raw=String(requestBody.template_data||'');
 if(raw.startsWith('data:image/')){try{const m=raw.match(/^data:image\/(png|jpeg|jpg);base64,([\s\S]+)$/i);if(m){const buf=Buffer.from(m[2],'base64');doc.image(buf,left,doc.y,{fit:[w,format.startsWith('thermal')?70:110],align:'center'});doc.moveDown(.8);}}catch(e){console.warn('Bill template image was skipped:',String(e));}}
 doc.fontSize(format.startsWith('thermal')?13:18).fillColor('#252126').text(b.snapshot_shop_name||'Shop',{width:w});
 doc.moveDown(.25).fontSize(9).fillColor('#333').text(b.snapshot_address||'').text(`Phone: ${b.snapshot_phone||'—'}${b.snapshot_gstin?'   GSTIN: '+b.snapshot_gstin:''}`);
 doc.moveDown(.7);
 const dateValue=String(b.created_at||'').includes('T')?b.created_at:String(b.created_at||'').replace(' ','T')+'Z';
 const dateLabel=new Date(dateValue).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'});
 const invoiceY=doc.y;doc.fontSize(14).fillColor('#111').text('INVOICE',left,invoiceY,{width:w*.55});doc.fontSize(10).text(b.invoice_no||'',left+w*.55,invoiceY,{width:w*.45,align:'right'});
 doc.moveDown(.55).fontSize(9).fillColor('#222').text(`Date: ${dateLabel}`).text(`Customer: ${b.customer_name||'Walk-in customer'}`).text(`Phone: ${b.customer_phone||'—'}`).text(`Payment: ${b.payment_method||'Cash'}`);
 doc.moveDown(.8);
 const cols=[{label:'Product',x:left,width:w*.46,align:'left'},{label:'Qty',x:left+w*.46,width:w*.14,align:'right'},{label:'Rate',x:left+w*.60,width:w*.13,align:'right'},{label:'GST',x:left+w*.73,width:w*.11,align:'right'},{label:'Amount',x:left+w*.84,width:w*.16,align:'right'}];
 const drawHeader=()=>{const y=doc.y;doc.fontSize(8).fillColor('#111');for(const col of cols)doc.text(col.label,col.x,y,{width:col.width,align:col.align});doc.y=y+14;doc.moveTo(left,doc.y).lineTo(right,doc.y).strokeColor('#aaa').lineWidth(.5).stroke();doc.y+=6;};
 drawHeader();
 for(const it of items.results){
   if(doc.y>doc.page.height-doc.page.margins.bottom-40){doc.addPage();drawHeader();}
   const y=doc.y;doc.fontSize(8).fillColor('#111');
   doc.text(String(it.product_name||''),cols[0].x,y,{width:cols[0].width-4});
   doc.text(`${it.quantity} ${it.unit||''}`.trim(),cols[1].x,y,{width:cols[1].width,align:'right'});
   doc.text(Number(it.unit_price||0).toFixed(2),cols[2].x,y,{width:cols[2].width,align:'right'});
   doc.text(`${Number(it.gst_rate||0)}%`,cols[3].x,y,{width:cols[3].width,align:'right'});
   doc.text(Number(it.line_total||0).toFixed(2),cols[4].x,y,{width:cols[4].width,align:'right'});
   doc.y=Math.max(doc.y,y+15);
 }
 doc.moveDown(.8);
 const totalsX=left+w*.38,totalsW=w*.62;
 doc.fontSize(9).fillColor('#222').text('Subtotal (before GST):',totalsX,doc.y,{width:totalsW*.62,align:'right',continued:false});
 let y=doc.y-11;doc.text(`₹${Number(b.subtotal||0).toFixed(2)}`,totalsX+totalsW*.62,y,{width:totalsW*.38,align:'right'});
 doc.y=Math.max(doc.y,y+15);y=doc.y;doc.text('GST:',totalsX,y,{width:totalsW*.62,align:'right'});doc.text(`₹${Number(b.gst_total||0).toFixed(2)}`,totalsX+totalsW*.62,y,{width:totalsW*.38,align:'right'});doc.y=y+16;
 y=doc.y;doc.fontSize(12).fillColor('#e87536').text('TOTAL:',totalsX,y,{width:totalsW*.62,align:'right'});doc.text(`₹${Number(b.total||0).toFixed(2)}`,totalsX+totalsW*.62,y,{width:totalsW*.38,align:'right'});doc.y=y+22;
 doc.moveDown(.6).fontSize(9).fillColor('#555').text('Thank you for shopping with us!',{align:'center',width:w});
 doc.end();const blob=await finished;return new Response(blob,{headers:{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${b.invoice_no||'EasyBill-invoice'}.pdf"`,'Cache-Control':'no-store'}});
}
app.post('/api/bills/:id/pdf',async c=>makePdf(c,c.req.param('id'),await body(c)));
app.get('/api/bills/:id/pdf',c=>makePdf(c,c.req.param('id'),{}));
app.notFound(c=>json(c,{error:'Not found.'},404));
app.onError((err,c)=>{console.error(err);return json(c,{error:'Internal server error.'},500);});
export default app;
