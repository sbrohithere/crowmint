import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authorization = request.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return json({ error: "Login is required" }, 401);
    const { orderId, paymentId, productIds, licenseType, message } = await request.json();
    if (!Array.isArray(productIds) || !productIds.length) return json({ error: "No products selected" }, 400);
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: products, error } = await admin.from("products").select("id,name").in("id", [...new Set(productIds.map(String))]);
    if (error) throw error;
    const fullName = userData.user.user_metadata?.full_name || userData.user.user_metadata?.name || userData.user.email || "CrowMint customer";
    const rows = (products || []).map(product => ({ order_id: orderId || `FAILED-${crypto.randomUUID()}`, payment_id: paymentId || null, user_id: userData.user.id, customer_name: fullName, customer_email: userData.user.email || "", product_id: String(product.id), product_name: product.name, license_type: licenseType === "commercial" ? "commercial" : "personal", amount_paid: 0, payment_status: "failed", failure_message: String(message || "Payment failed").slice(0, 500) }));
    const { error: insertError } = await admin.from("orders").insert(rows);
    if (insertError) throw insertError;
    return json({ recorded: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to record failed payment" }, 500);
  }
});
