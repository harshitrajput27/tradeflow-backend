// ─── Base layout ─────────────────────────────────────────────────────────
function base(content) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  .wrap{max-width:580px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)}
  .header{background:#0C447C;padding:24px 32px;color:#fff}
  .header h1{margin:0;font-size:20px;font-weight:500;letter-spacing:-0.3px}
  .header p{margin:4px 0 0;font-size:12px;opacity:.7}
  .body{padding:28px 32px}
  .body p{margin:0 0 16px;font-size:14px;color:#333;line-height:1.6}
  .stat-row{display:flex;gap:12px;margin:20px 0}
  .stat{flex:1;background:#f8f8f8;border-radius:6px;padding:14px 16px}
  .stat-label{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
  .stat-value{font-size:18px;font-weight:600;color:#111}
  .badge{display:inline-block;padding:4px 12px;border-radius:99px;font-size:12px;font-weight:600}
  .badge-buy{background:#e1f5ee;color:#0f6e56}
  .badge-sell{background:#fcebeb;color:#a32d2d}
  .badge-success{background:#e1f5ee;color:#0f6e56}
  .cta{display:block;margin:24px 0 0;padding:12px 24px;background:#185FA5;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500;text-align:center;width:fit-content}
  .divider{border:none;border-top:1px solid #eee;margin:24px 0}
  .footer{padding:16px 32px;background:#fafafa;border-top:1px solid #eee;font-size:11px;color:#aaa;line-height:1.6}
  .pnl-positive{color:#0f6e56;font-weight:600}
  .pnl-negative{color:#a32d2d;font-weight:600}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <h1>TradeFlow</h1>
    <p>NSE · BSE · F&amp;O</p>
  </div>
  <div class="body">${content}</div>
  <div class="footer">
    This is an automated message from TradeFlow. Please do not reply to this email.<br/>
    © ${new Date().getFullYear()} TradeFlow. All rights reserved.
  </div>
</div>
</body>
</html>`;
}

// ─── Welcome email ───────────────────────────────────────────────────────
function renderWelcomeEmail(email) {
  return base(`
    <p style="font-size:18px;font-weight:500;color:#111;margin-bottom:8px">Welcome to TradeFlow! 🎉</p>
    <p>Your account for <b>${email}</b> has been created successfully. You can now start trading across NSE, BSE, and F&O.</p>
    <hr class="divider"/>
    <p><b>Get started:</b></p>
    <p>1. Complete your KYC verification<br/>2. Add funds to your account<br/>3. Start trading</p>
    <a class="cta" href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/dashboard">Open Dashboard</a>
  `);
}

// ─── Order placed email ───────────────────────────────────────────────────
function renderOrderPlacedEmail(name, event) {
  const badgeClass = event.transactionType === 'BUY' ? 'badge-buy' : 'badge-sell';
  return base(`
    <p>Hi <b>${name}</b>,</p>
    <p>Your order has been placed successfully.</p>
    <div class="stat-row">
      <div class="stat">
        <div class="stat-label">Instrument</div>
        <div class="stat-value">${event.instrument}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Type</div>
        <div class="stat-value"><span class="badge ${badgeClass}">${event.transactionType}</span></div>
      </div>
    </div>
    <div class="stat-row">
      <div class="stat">
        <div class="stat-label">Quantity</div>
        <div class="stat-value">${event.quantity}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Price</div>
        <div class="stat-value">₹${event.price || 'Market'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Product</div>
        <div class="stat-value">${event.productType}</div>
      </div>
    </div>
    <p style="font-size:12px;color:#888">Order ID: ${event.orderId}</p>
    <a class="cta" href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/orders">View Orders</a>
  `);
}

// ─── Order fill email ─────────────────────────────────────────────────────
function renderOrderFillEmail(name, event, pnl) {
  const badgeClass = event.transactionType === 'BUY' ? 'badge-buy' : 'badge-sell';
  const pnlHtml = pnl != null
    ? `<div class="stat"><div class="stat-label">P&amp;L</div>
       <div class="stat-value ${pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">
         ${pnl >= 0 ? '+' : ''}₹${Math.abs(pnl).toFixed(2)}
       </div></div>`
    : '';

  return base(`
    <p>Hi <b>${name}</b>,</p>
    <p>Your order has been <b>executed</b> successfully.</p>
    <div class="stat-row">
      <div class="stat">
        <div class="stat-label">Instrument</div>
        <div class="stat-value">${event.instrument || event.instrumentKey?.split('|')[1] || '—'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Side</div>
        <div class="stat-value"><span class="badge ${badgeClass}">${event.transactionType}</span></div>
      </div>
    </div>
    <div class="stat-row">
      <div class="stat">
        <div class="stat-label">Quantity</div>
        <div class="stat-value">${event.quantity}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Avg Price</div>
        <div class="stat-value">₹${event.price}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Value</div>
        <div class="stat-value">₹${(event.quantity * event.price).toLocaleString('en-IN')}</div>
      </div>
      ${pnlHtml}
    </div>
    <a class="cta" href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/portfolio">View Portfolio</a>
  `);
}

module.exports = { renderWelcomeEmail, renderOrderPlacedEmail, renderOrderFillEmail };
