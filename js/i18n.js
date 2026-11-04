/* ==========================================================================
   i18n.js — tiny dictionary-based translation layer (English / Vietnamese).
   Strings live in js/dict.js. Three ways to translate markup:
     data-i18n="key"          -> element text
     data-i18n-label="key"    -> aria-label
     data-i18n-ph="key"       -> placeholder
     data-i18n-tip="key"      -> data-tip (CSS tooltip)
   plus the original convention: any dictionary key that starts with "t_" and matches an element id.
   Dynamic strings call t('key', { n: 3 }).
   ========================================================================== */

const $ = id => document.getElementById(id);
let currentLang = 'en';

/** Translate into a given language. The UI uses t() (the app language); the card studio uses tl() with its own, separate card language. */
function tl(lang, key, vars) {
  const D = window.dict || {};
  let s = D[lang] && D[lang][key];
  if (s === undefined) s = D.en && D.en[key];
  if (s === undefined) return key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  return s;
}

function t(key, vars) { return tl(currentLang, key, vars); }

function applyI18n(root) {
  root = root || document;
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-label]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nLabel)); });
  root.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll('[data-i18n-tip]').forEach(el => { el.dataset.tip = t(el.dataset.i18nTip); });
  if (root === document) {
    const en = (window.dict && window.dict.en) || {};
    for (const k of Object.keys(en)) {
      if (k.indexOf('t_') !== 0) continue;
      const el = document.getElementById(k);
      if (el) el.textContent = t(k);
    }
  }
}

function setLang(l) {
  if (!window.dict || !window.dict[l]) l = 'en';
  currentLang = l;
  document.documentElement.lang = l;
  try { localStorage.setItem('fms-lang', l); } catch (e) { /* private mode: language just isn't remembered */ }
  applyI18n();
  document.dispatchEvent(new CustomEvent('langchange', { detail: { lang: l } }));
}

function initLang() {
  let l = 'en';
  try { const s = localStorage.getItem('fms-lang'); if (s === 'en' || s === 'vi') l = s; } catch (e) { /* ignore */ }
  setLang(l);
}
