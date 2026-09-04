import { createClient } from '@supabase/supabase-js';

// ==========================================
// KONFIGURASI SUPABASE & ENVIRONMENT
// ==========================================
// Menggunakan fallback URL langsung untuk menghindari variabel kosong di Railway
const SUPABASE_URL = "https://fjssijgbemvyjcvpizko.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const WORKER_ID = process.env.WORKER_ID || 1;

const TARGET_WORDS = 2000;
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error("❌ Error: SUPABASE_SERVICE_ROLE_KEY belum diatur di Environment Variables Railway!");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const apiKeysEnv = process.env.GROQ_API_KEYS || "";
const apiKeys = apiKeysEnv.split(',').map(k => k.trim()).filter(Boolean);

if (apiKeys.length === 0) {
    console.error("❌ Error: GROQ_API_KEYS belum diatur di Environment Variables Railway!");
    process.exit(1);
}

let apiKeyIndex = 0;
function getNextGroqApiKey() {
    const key = apiKeys[apiKeyIndex];
    apiKeyIndex = (apiKeyIndex + 1) % apiKeys.length;
    return key;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// AI GENERATOR (GROQ)
// ==========================================
async function generateContent(keyword, apiKey) {
    const prompt = `Write a comprehensive, informative, and naturally flowing article in English containing at least ${TARGET_WORDS} words.

The article must be centered around the following keyword:
${keyword}

Requirements:
- Write naturally for human readers.
- Use SEO best practices.
- Include informative headings and subheadings.
- Use clean HTML only (<h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong> where appropriate).
- Do not use Markdown.
- Return only the HTML content.
- Create an engaging introduction.
- Use semantic keywords naturally.
- Add a concise conclusion.
- Avoid keyword stuffing.
- Ensure the content is original and easy to read.`;

    const payload = {
        model: "openai/gpt-oss-20b",
        messages: [
            {
                role: "system",
                content: "You are an experienced professional Content Writer and SEO expert specializing in creating high-quality, engaging, and search engine-optimized content in clean HTML format."
            },
            {
                role: "user",
                content: prompt
            }
        ],
        temperature: 0.7,
        max_tokens: 3000
    };

    let retry = 0;
    const maxRetries = 3;

    while (retry < maxRetries) {
        try {
            const response = await fetch(GROQ_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'User-Agent': 'Mozilla/5.0'
                },
                body: JSON.stringify(payload)
            });

            if (response.status === 429 || response.status >= 500) {
                console.warn(`⚠️ Groq Warning HTTP ${response.status}. Retrying (${retry + 1}/${maxRetries})...`);
                retry++;
                await sleep(3000 * (retry + 1));
                continue;
            }

            const data = await response.json();
            if (data.error) {
                console.error("❌ Groq API Error:", data.error);
                retry++;
                await sleep(2000);
                continue;
            }

            return data.choices?.[0]?.message?.content || false;
        } catch (err) {
            console.error(`❌ Network Error (retry ${retry}):`, err.message);
            retry++;
            await sleep(2000);
        }
    }

    return false;
}

// ==========================================
// GENERATE CATEGORY & TAGS
// ==========================================
async function generateMetadata(keyword) {
    return {
        category: "General",
        tags: keyword.split(' ').filter(word => word.length > 3)
    };
}

// ==========================================
// MAIN WORKER LOOP
// ==========================================
async function startWorker() {
    console.log(`[${new Date().toLocaleTimeString()}] 🚀 Worker ${WORKER_ID} STARTED`);
    console.log(`🔑 Total Groq API Keys loaded: ${apiKeys.length}`);

    while (true) {
        try {
            // Ambil data yang content-nya NULL, diurutkan dari ID paling akhir (terbesar)
            const { data: rows, error: fetchError } = await supabase
                .from('keywords')
                .select('*')
                .is('content', null)
                .order('id', { ascending: false })
                .limit(1);

            if (fetchError) {
                console.error("❌ Supabase fetch error:", fetchError.message);
                await sleep(5000);
                continue;
            }

            if (!rows || rows.length === 0) {
                console.log(`[${new Date().toLocaleTimeString()}] 💤 Queue kosong (semua keyword sudah memiliki content). Menunggu 10 detik...`);
                await sleep(10000);
                continue;
            }

            const job = rows[0];
            const keywordText = job.keyword || job.text;
            console.log(`\n[${new Date().toLocaleTimeString()}] [Worker ${WORKER_ID}] Memproses ID Terakhir #${job.id}: "${keywordText}"`);

            // Rotasi API Key
            const apiKey = getNextGroqApiKey();
            console.log(`  🔑 Menggunakan API Key index ke-${apiKeyIndex} (...${apiKey.slice(-6)})`);

            // Generate Konten & Metadata
            const contentResult = await generateContent(keywordText, apiKey);
            const metadata = await generateMetadata(keywordText);

            if (contentResult) {
                // Hitung jumlah kata
                const cleanText = contentResult.replace(/<[^>]*>/g, ' ');
                const wordCount = cleanText.trim().split(/\s+/).filter(Boolean).length;

                // Update ke Supabase
                const { error: updateError } = await supabase
                    .from('keywords')
                    .update({
                        content: contentResult,
                        category: job.category || metadata.category,
                        tags: job.tags && job.tags.length > 0 ? job.tags : metadata.tags
                    })
                    .eq('id', job.id);

                if (updateError) {
                    console.error(`  ❌ Gagal update database untuk ID #${job.id}:`, updateError.message);
                } else {
                    console.log(`  ✔ Berhasil generate & update database untuk ID #${job.id}`);
                    console.log(`  📊 Jumlah kata artikel: ${wordCount} kata`);
                }
            } else {
                console.log(`  ❌ Gagal generate konten via AI untuk: "${keywordText}"`);
            }

            // Jeda acak 2 - 5 detik
            const delay = Math.floor(Math.random() * 3000) + 2000;
            await sleep(delay);

        } catch (err) {
            console.error("❌ Error di worker loop:", err);
            await sleep(5000);
        }
    }
}

startWorker();