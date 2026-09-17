function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function dataUrlContent(data = "") {
  const comma = data.indexOf(",");
  return comma >= 0 ? data.slice(comma + 1) : data;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const order = body.order || {};
    const attachments = (body.attachments || []).slice(0, 30).map((file) => ({
      filename: String(file.name || "production-file.png"),
      content: dataUrlContent(file.data),
    }));
    const apiKey = process.env.RESEND_API_KEY || "";
    if (!apiKey) return res.status(503).json({ error: "邮件服务尚未配置" });
    const profileUrl = String(order.cloudProfile?.publicUrl || "");
    const petName = String(order.petName || order.nfcProfile?.petName || "Lucky");
    const profileSection = profileUrl
      ? `<div style="margin:24px 0;padding:18px;border:2px solid #ef4444;border-radius:12px;background:#fff7f7"><h3 style="margin:0 0 10px">NFC 锁定档案网址</h3><p style="margin:0 0 12px;word-break:break-all"><a href="${escapeHtml(profileUrl)}">${escapeHtml(profileUrl)}</a></p><a href="${escapeHtml(profileUrl)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#111;color:#fff;text-decoration:none">打开并检查档案</a><p style="margin:12px 0 0;color:#b42318">请把上面这个网址写入实体 NFC。客户没有编辑入口。</p></div>`
      : `<p style="color:#b42318"><b>注意：</b>本邮件没有收到 NFC 档案网址，请不要写入 NFC。</p>`;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "TSUN88-Order-Site/1.0",
      },
      body: JSON.stringify({
        from: "TSUN88订单 <onboarding@resend.dev>",
        to: ["Tsunlab888@163.com"],
        subject: `TSUN88已付款订单 ${String(order.id || "")}｜${petName}`,
        html: `<h2>TSUN88 已付款狗牌订单</h2><p><b>订单号：</b>${escapeHtml(order.id || "未生成")}</p><p><b>宠物名字：</b>${escapeHtml(petName)}</p><p><b>狗牌数量：</b>${Number(order.itemCount || 1)} 张</p><p><b>收货人：</b>${escapeHtml(order.shipName)}</p><p><b>联系电话：</b>${escapeHtml(order.shipPhone)}</p><p><b>地址：</b>${escapeHtml(order.shipAddress)}</p><p><b>付款方式：</b>${escapeHtml(order.payMethod)}</p>${profileSection}<p>生产用透明 PNG 文件已作为附件发送。</p>`,
        attachments,
      }),
    });
    const result = await response.json().catch(() => ({}));
    return res.status(response.status).json(result);
  } catch {
    return res.status(500).json({ error: "订单邮件生成失败" });
  }
};
