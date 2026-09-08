/* ═══════════════════════════════════════════════════════════
   MODULE 6 — APPEL VIA PROXY CLOUDFLARE
   Commune de Sainte-Ode · v7.0
   ═══════════════════════════════════════════════════════════ */

const PROXY_URL = "https://ode-push.lepoint2023.workers.dev/llm";

const HISTORY_MAX   = 20;
const FETCH_TIMEOUT = 45000;
const MAX_TOKENS    = 1500;

let activeProvider = "groq";

/* ── Messages multilingues ── */
const MSG_ERREUR = {
  fr: "Désolé, je n'ai pas pu traiter votre demande. Contactez-nous au **+32 61 21 04 40**.",
  nl: "Sorry, uw verzoek kon niet worden verwerkt. Bel ons op **+32 61 21 04 40**.",
  en: "Sorry, your request could not be processed. Contact us at **+32 61 21 04 40**.",
  de: "Entschuldigung, Ihre Anfrage konnte nicht bearbeitet werden. Rufen Sie uns an: **+32 61 21 04 40**.",
  es: "Lo sentimos, no pudimos procesar su solicitud. Contáctenos en **+32 61 21 04 40**.",
  ar: "عذراً، لم نتمكن من معالجة طلبك. اتصل بنا على **+32 61 21 04 40**."
};

const MSG_CONNEXION = {
  fr: "⚠️ Connexion indisponible. Contactez-nous au **+32 61 21 04 40** ou via [le guichet citoyen](https://sainteode.guichet-citoyen.be/).",
  nl: "⚠️ Verbinding niet beschikbaar. Bel **+32 61 21 04 40** of via [het burgerloket](https://sainteode.guichet-citoyen.be/).",
  en: "⚠️ Connection unavailable. Contact us at **+32 61 21 04 40** or via [citizen portal](https://sainteode.guichet-citoyen.be/).",
  de: "⚠️ Verbindung nicht verfügbar. Rufen Sie uns an: **+32 61 21 04 40** oder [Bürgerportal](https://sainteode.guichet-citoyen.be/).",
  es: "⚠️ Conexión no disponible. Contáctenos en **+32 61 21 04 40** o via [portal ciudadano](https://sainteode.guichet-citoyen.be/).",
  ar: "⚠️ الاتصال غير متاح. اتصل بنا على **+32 61 21 04 40** أو عبر [بوابة المواطن](https://sainteode.guichet-citoyen.be/)."
};

const MSG_QUOTA = {
  fr: "⚠️ Le service est temporairement saturé. Réessayez dans quelques instants ou appelez-nous au **+32 61 21 04 40**.",
  nl: "⚠️ De service is tijdelijk overbelast. Probeer het later opnieuw of bel **+32 61 21 04 40**.",
  en: "⚠️ The service is temporarily overloaded. Please try again shortly or call **+32 61 21 04 40**.",
  de: "⚠️ Der Dienst ist vorübergehend überlastet. Versuchen Sie es später oder rufen Sie **+32 61 21 04 40** an.",
  es: "⚠️ El servicio está temporalmente saturado. Inténtelo de nuevo o llame al **+32 61 21 04 40**.",
  ar: "⚠️ الخدمة مثقلة مؤقتاً. يرجى المحاولة مرة أخرى أو الاتصال على **+32 61 21 04 40**."
};

const MSG_TIMEOUT = {
  fr: "⚠️ La réponse prend trop de temps. Vérifiez votre connexion ou contactez-nous au **+32 61 21 04 40**.",
  nl: "⚠️ Het antwoord duurt te lang. Controleer uw verbinding of bel **+32 61 21 04 40**.",
  en: "⚠️ The response is taking too long. Check your connection or contact us at **+32 61 21 04 40**.",
  de: "⚠️ Die Antwort dauert zu lange. Überprüfen Sie Ihre Verbindung oder rufen Sie **+32 61 21 04 40** an.",
  es: "⚠️ La respuesta tarda demasiado. Verifique su conexión o contáctenos en **+32 61 21 04 40**.",
  ar: "⚠️ الاستجابة تستغرق وقتاً طويلاً. تحقق من اتصالك أو اتصل على **+32 61 21 04 40**."
};

/* ── Historique ── */
let history = [];
let loading  = false;

function loadHistory() {
  try {
    const stored = sessionStorage.getItem("chatHistory");
    if (stored) history = JSON.parse(stored);
  } catch (e) { history = []; }
}

function saveHistory() {
  try { sessionStorage.setItem("chatHistory", JSON.stringify(history)); }
  catch (e) {}
}

/* ── Helpers ── */
function getLang() {
  return (typeof window.lang === "string" && window.lang) ? window.lang : "fr";
}
function getSelectedSvc() {
  return (typeof window.selectedSvc !== "undefined") ? window.selectedSvc : null;
}
function safeGetQR() {
  if (typeof getQR === "function") {
    try { return getQR(); } catch (e) { return undefined; }
  }
  return undefined;
}

/* ── Extraction réponse selon provider ── */
function _extractReply(data, provider, lang) {
  if (provider === "groq") {
    return data?.choices?.[0]?.message?.content || MSG_ERREUR[lang];
  }
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || MSG_ERREUR[lang];
}

/* ══════════════════════════════════════════════════════
   APPEL AU PROXY — format unifié
   ══════════════════════════════════════════════════════ */
async function _callProxy(provider, systemPrompt, msgs, signal) {
  return await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      provider:     provider,
      systemPrompt: "", /* Prompt lu depuis KV côté Worker */
      messages:     msgs,
      maxTokens:    MAX_TOKENS
    })
  });
}

/* ══════════════════════════════════════════════════════
   APPEL PRINCIPAL — streaming SSE robuste
   ══════════════════════════════════════════════════════ */
async function callGemini(userMessage) {
  loading = true;
  document.getElementById("send-btn").disabled = true;

  const lang         = getLang();
  const systemPrompt = buildPrompt(getSelectedSvc(), lang);

  history.push({ role: "user", content: userMessage });
  if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
  saveHistory();

  showTyping();

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await _callProxy(activeProvider, systemPrompt, history, controller.signal);
    clearTimeout(timeoutId);

    if (!response.ok) {
      hideTyping();
      if (typeof setStatus === "function") setStatus("offline");
      _callAddMsg("bot", MSG_CONNEXION[lang]);
      _finaliseCall();
      return;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('event-stream') || !response.body) {
      /* Fallback JSON si pas de stream */
      const data  = await response.json();
      const reply = _extractReply(data, activeProvider, lang);
      hideTyping();
      if (typeof setStatus === "function") setStatus("online");
      _callAddMsg("bot", reply, safeGetQR());
      history.push({ role: "assistant", content: reply });
      saveHistory();
      _finaliseCall();
      return;
    }

    /* ── Streaming ── */
    hideTyping();
    if (typeof setStatus === "function") setStatus("online");

    /* 1. Créer la bulle vide AVANT de lire les chunks */
    _callAddMsg("bot", "▍");
    await new Promise(r => setTimeout(r, 30)); /* laisser le DOM se mettre à jour */

    const msgs = document.getElementById("messages");
    let bubbleEl = null;
    if (msgs) {
      const rows = msgs.querySelectorAll(".msg-row.bot");
      const last = rows[rows.length - 1];
      bubbleEl = last ? last.querySelector(".bbl.bot") : null;
    }

    /* 2. Lire le stream SSE chunk par chunk */
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';
    let fullText  = '';

    const render = (text, cursor) => {
      if (!bubbleEl) return;
      const out = cursor ? text + '▍' : text;
      if (typeof window.parseMarkdown === 'function') {
        bubbleEl.innerHTML = window.parseMarkdown(out);
      } else {
        bubbleEl.textContent = out;
      }
    };

    outer: while (true) {
      let done, value;
      try { ({ done, value } = await reader.read()); }
      catch (e) { break; }
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);

        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;

        const raw = line.slice(5).trim();
        if (raw === '[DONE]') break outer;

        try {
          const parsed = JSON.parse(raw);
          const delta  = parsed.choices?.[0]?.delta?.content || '';
          if (delta) { fullText += delta; render(fullText, true); }
        } catch (e) { /* chunk incomplet */ }
      }
    }

    /* 3. Rendu final sans curseur */
    if (fullText) {
      render(fullText, false);
      history.push({ role: "assistant", content: fullText });
      saveHistory();
    } else if (bubbleEl) {
      bubbleEl.closest('.msg-row')?.remove();
      _callAddMsg("bot", MSG_ERREUR[lang]);
    }

  } catch (error) {
    clearTimeout(timeoutId);
    hideTyping();
    console.error('[OdeBot Stream Error]', error.name, error.message, error);
    const isTimeout = error.name === "AbortError";
    if (typeof setStatus === "function") setStatus("offline");
    _callAddMsg("bot", isTimeout ? MSG_TIMEOUT[lang] : MSG_CONNEXION[lang]);
  }

  _finaliseCall();
}

/* ── Finalisation ── */
function _finaliseCall() {
  loading = false;
  const btn   = document.getElementById("send-btn");
  const input = document.getElementById("chat-input");
  if (btn) btn.disabled = false;
  /* Ne pas remettre le focus — le clavier ne s'ouvre que si l'utilisateur tape */
  if (input) input.blur();
}

/* ── Résolution tardive de addMsg (défini dans index.html après module6) ── */
function _callAddMsg(role, text, qrs) {
  if (typeof window.addMsg === "function") {
    window.addMsg(role, text, qrs);
  } else {
    /* Fallback : réessayer après que le script inline soit chargé */
    setTimeout(function() { _callAddMsg(role, text, qrs); }, 100);
  }
}

/* ── Envoi d'un message ── */
async function sendMsg(text) {
  const input   = document.getElementById("chat-input");
  const message = text !== undefined ? text : input.value.trim();
  if (!message || loading) return;
  if (text === undefined) {
    input.value        = "";
    input.style.height = "auto";
  }
  _callAddMsg("user", message);
  await callGemini(message);
}

function sendMessage() { sendMsg(); }

/* ── Réinitialisation ── */
function resetChat() {
  history = [];
  sessionStorage.removeItem("chatHistory");
  window.selectedSvc = null;
  if (window._usedQR) window._usedQR.clear();

  const area = document.getElementById("messages");
  const s    = S[getLang()] || S.fr;

  area.innerHTML = '<div class="ts" id="ts-label">' + s.ts + "</div>";
  document.getElementById("svc-pill").classList.remove("on");
  document.getElementById("chat-input").placeholder = s.ph;

  setTimeout(function () {
    _callAddMsg("bot", s.welcome);
    setTimeout(showSvcSelector, 2500);
  }, 300);
}

loadHistory();
