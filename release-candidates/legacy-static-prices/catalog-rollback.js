(() => {
  // src/catalog/config.js
  var SHEET_CSV_URL = "https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-feeds/trees.csv";
  var DECOR_SHEET_CSV_URL = "https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-feeds/decor.csv";
  var PROMO_SHEET_CSV_URL = "https://mgnotvaahftrbifqtahf.supabase.co/storage/v1/object/public/le-catalog-feeds/promos.csv";
  var CARD_SEL = ".product-card, .product-wrapper__cms";
  var IMG_WRAP_SEL = ".product__img, .product__img__cms";
  var EXTRA_IMG_WRAP_SEL = ".product__img-dop, .product__img-dop__cms";

  // src/catalog/utils.js
  var $$ = (s) => Array.from(document.querySelectorAll(s));
  var num = (s) => Number(String(s || "").replace(/[^\d.-]/g, ""));
  var rub = (n) => (Number(n) || 0).toLocaleString("ru-RU") + " ₽";
  var norm = (s) => String(s || "").trim().toLowerCase().replace(/[ёЁ]/g, "е").replace(/\s+/g, " ");
  if (typeof window !== "undefined") window.norm = norm;
  var normCat = (s) => norm(
    String(s || "").replace(/&quot;|&#34;/gi, '"').replace(/^"(.*)"$/, "$1")
  );
  function parseCSV(txt) {
    const o = [], r = [];
    let i = 0, c = "", q = false;
    while (i < txt.length) {
      const ch = txt[i];
      if (q) {
        if (ch == '"' && txt[i + 1] == '"') {
          c += '"';
          i += 2;
          continue;
        }
        if (ch == '"') {
          q = false;
          i++;
          continue;
        }
        c += ch;
        i++;
        continue;
      }
      if (ch == '"') {
        q = true;
        i++;
        continue;
      }
      if (ch == ",") {
        r.push(c);
        c = "";
        i++;
        continue;
      }
      if (ch == "\n") {
        r.push(c);
        o.push(r.slice());
        r.length = 0;
        c = "";
        i++;
        continue;
      }
      if (ch == "\r") {
        i++;
        continue;
      }
      c += ch;
      i++;
    }
    if (c.length || r.length) {
      r.push(c);
      o.push(r);
    }
    return o;
  }
  function isThankUrl(href) {
    try {
      const u = new URL(href, location.href);
      const p = (u.pathname || "").toLowerCase();
      return /(?:^|\/)(spasibo|thanks)(?:\/|$)/.test(p);
    } catch {
      return false;
    }
  }
  function hideCard(card) {
    if (!card) return;
    card.classList.add("is-inactive", "no-active-rows");
    card.setAttribute("hidden", "");
    card.style.setProperty("display", "none", "important");
    card.style.visibility = "hidden";
    card.style.pointerEvents = "none";
    requestAnimationFrame(() => {
      if (card.isConnected) card.remove();
    });
  }
  function findField(form, label) {
    return form.querySelector(`[name="${label}"], input[placeholder="${label}"]`);
  }
  function ghostify(el) {
    if (!el) return;
    const wrap = el.closest(".form__field") || el;
    wrap.setAttribute("data-le-hide", "");
    el.removeAttribute("required");
    el.setAttribute("tabindex", "-1");
    el.setAttribute("aria-hidden", "true");
  }
  function haveBuilderFields(form) {
    const labels = ["Товар", "Общая сумма"];
    return labels.every((n) => !!findField(form, n));
  }
  function fillBuilderFields(form, item) {
    const set = (label, val) => {
      const el = findField(form, label);
      if (!el) return;
      el.value = String(val != null ? val : "");
      ghostify(el);
    };
    const price = Number(String(item.price || 0).replace(/[^\d.-]/g, "")) || 0;
    const qty = Number(item.qty || 1);
    const itemTotal = price * qty;
    const itemDesc = [
      item.name || "Товар",
      item.height ? `${item.height} см` : "",
      item.category ? `(${item.category})` : "",
      qty > 1 ? `x${qty}` : "",
      `${itemTotal} ₽`
    ].filter(Boolean).join(" ");
    let totalPrice = itemTotal;
    try {
      const promoState = JSON.parse(localStorage.getItem("lady_promo_state") || "null");
      if (promoState && promoState.rub > 0) {
        totalPrice = Math.max(0, itemTotal - promoState.rub);
      } else if (promoState && promoState.pct > 0) {
        totalPrice = Math.max(0, Math.round(itemTotal * (1 - promoState.pct / 100)));
      }
    } catch (e) {
    }
    set("Товар", itemDesc);
    set("Общая сумма", String(totalPrice || 0));
  }
  function fillBuilderFieldsMultiple(form, cart) {
    if (!cart || !cart.length) return;
    const set = (label, val) => {
      const el = findField(form, label);
      if (!el) return;
      el.value = String(val != null ? val : "");
      ghostify(el);
    };
    const itemsList = cart.map((item) => {
      const price = Number(String(item.price || 0).replace(/[^\d.-]/g, "")) || 0;
      const qty = Number(item.qty || 1);
      const itemTotal = price * qty;
      const parts = [item.name || "Товар"];
      if (item.height) parts.push(`${item.height} см`);
      if (item.category) parts.push(`(${item.category})`);
      if (qty > 1) parts.push(`x${qty}`);
      parts.push(`${itemTotal} ₽`);
      return parts.join(" ");
    }).join("; ");
    const categories = [...new Set(cart.map((i) => i.category).filter(Boolean))].join("; ");
    const heights = cart.map((i) => i.height).filter(Boolean).join("; ");
    const baseTotal = cart.reduce((sum, item) => {
      const price = Number(String(item.price || 0).replace(/[^\d.-]/g, "")) || 0;
      const qty = Number(item.qty || 1);
      return sum + price * qty;
    }, 0);
    let totalPrice = baseTotal;
    try {
      const promoState = JSON.parse(localStorage.getItem("lady_promo_state") || "null");
      if (promoState && promoState.rub > 0) {
        totalPrice = Math.max(0, baseTotal - promoState.rub);
      } else if (promoState && promoState.pct > 0) {
        totalPrice = Math.max(0, Math.round(baseTotal * (1 - promoState.pct / 100)));
      }
    } catch (e) {
    }
    set("Товар", itemsList);
    set("Общая сумма", String(totalPrice || 0));
  }

  // src/catalog/sheets.js
  var normId = (s) => String(s || "").trim().toLowerCase();
  async function loadDict(cache = "default") {
    var _a;
    const csv = await fetch(SHEET_CSV_URL, { cache }).then((r) => r.text());
    const rows = parseCSV(csv);
    if (!rows.length) throw new Error("csv empty");
    const head = rows.shift().map((h) => String(h || "").trim().toLowerCase().replace(/[ё]/g, "е"));
    const alias = {
      id: ["id", "код", "sku", "артикул"],
      discount_pct: ["discount_pct", "discount", "сумма скидки", "скидка"],
      title: ["title", "наименование", "товар"],
      category: ["category", "категория"],
      height_cm: ["height_cm", "высота"],
      price: ["price", "новая цена", "цена", "цена на таблице"],
      diameter_cm: ["diameter_cm", "диаметр"],
      branches: ["branches", "кол-во веток", "количество веток"],
      offer: ["offer", "цена без скидки", "старая цена"],
      photos: ["photos", "фото", "картинки", "галерея"],
      active: ["active", "актив", "активно", "показывать", "show", "visible"],
      description: ["description", "описание", "desc"]
    };
    const col = (k) => (alias[k] || []).map((a) => head.indexOf(a)).find((i) => i >= 0);
    ["title", "category", "height_cm", "price"].forEach((k) => {
      if (col(k) == null) throw new Error("нет колонки: " + k);
    });
    const byId = /* @__PURE__ */ new Map();
    const byTitle = /* @__PURE__ */ new Map();
    const ensure = (map, key, title) => {
      if (!key) return null;
      if (!map.has(key)) map.set(key, { title: title || "", cats: /* @__PURE__ */ new Map() });
      const e = map.get(key);
      if (title && !e.title) e.title = title;
      return e;
    };
    for (const r of rows) {
      const idRaw = col("id") != null ? r[col("id")] || "" : "";
      const idKey = normId(idRaw);
      const tRaw = (r[col("title")] || "").trim();
      const tKey = normCat(tRaw);
      const cRaw = (r[col("category")] || "").trim();
      const cKey = normCat(cRaw);
      const h = num(r[col("height_cm")] || "");
      const p = num(r[col("price")] || "");
      const d = num(r[col("diameter_cm")] || "");
      const b = num(r[col("branches")] || "");
      const off = num(r[col("offer")] || "");
      const dpctRaw = (col("discount_pct") != null ? r[col("discount_pct")] || "" : "") + "";
      const dpct = num(dpctRaw.replace("%", ""));
      const desc = col("description") != null ? (r[col("description")] || "").trim() : "";
      const phRaw = col("photos") != null ? r[col("photos")] || "" : "";
      const photos = phRaw.split("|").map((s) => s.trim()).filter(Boolean);
      const iActive = col("active");
      const hasActiveCol = iActive != null;
      const aRaw = hasActiveCol ? (_a = r[iActive]) != null ? _a : "" : "";
      const isActive = (() => {
        if (!hasActiveCol) return true;
        const s = String(aRaw).trim().toLowerCase();
        if (s === "") return false;
        const YES = /* @__PURE__ */ new Set(["1", "true", "t", "да", "yes", "y", "on", "ok", "✓", "&#x2714;", "истина"]);
        const NO = /* @__PURE__ */ new Set(["0", "false", "f", "нет", "no", "n", "off", "x", "✗", "×", "-", "ложь"]);
        if (YES.has(s)) return true;
        if (NO.has(s)) return false;
        const n = Number(s.replace(",", "."));
        return !Number.isNaN(n) ? n > 0 : false;
      })();
      if (!cRaw || !h || !p) continue;
      if (!isActive) continue;
      [ensure(byId, idKey, tRaw), ensure(byTitle, tKey, tRaw)].filter(Boolean).forEach((entry) => {
        if (!entry.cats.has(cKey)) entry.cats.set(cKey, []);
        entry.cats.get(cKey).push({
          height: h,
          price: p,
          diam: d || "",
          branches: b || "",
          offer: off || "",
          discount: dpct || 0,
          category: cRaw,
          description: desc || "",
          // ← сохраняем описание на уровне категории
          photos
        });
        if (desc && !entry.description) entry.description = desc;
      });
    }
    const sort = (e) => e && e.cats.forEach((list) => list.sort((a, b) => a.height - b.height));
    byId.forEach(sort);
    byTitle.forEach(sort);
    return { byId, byTitle };
  }
  async function loadDecorDict(cache = "default") {
    var _a;
    const csv = await fetch(DECOR_SHEET_CSV_URL, { cache }).then((r) => r.text());
    const rows = parseCSV(csv);
    if (!rows.length) throw new Error("decor csv empty");
    const head = rows.shift().map((h) => String(h || "").trim().toLowerCase().replace(/[ё]/g, "е"));
    const alias = {
      id: ["id", "код", "sku", "артикул"],
      title: ["title", "наименование", "товар"],
      category: ["category", "категория", "тип"],
      price: ["price", "оригинальная цена", "цена", "цена на таблице"],
      description: ["description", "описание", "desc"],
      photos: ["photos", "фото", "картинки", "галерея"],
      active: ["active", "актив", "активно", "показывать", "show", "visible"],
      variants: ["variants", "варианты", "вариант", "размеры"]
    };
    const col = (k) => (alias[k] || []).map((a) => head.indexOf(a)).find((i) => i >= 0);
    ["title", "price"].forEach((k) => {
      if (col(k) == null) throw new Error("нет колонки декора: " + k);
    });
    const byId = /* @__PURE__ */ new Map();
    const byTitle = /* @__PURE__ */ new Map();
    const variantsByProductId = /* @__PURE__ */ new Map();
    function extractSize(variantsStr) {
      if (!variantsStr || !variantsStr.trim()) return null;
      const sizeMatch = variantsStr.match(/(\d+)[хxХX](\d+)[хxХX](\d+)/i);
      if (!sizeMatch) return null;
      return `${sizeMatch[1]}х${sizeMatch[2]}х${sizeMatch[3]}`;
    }
    const ensure = (map, key, title) => {
      if (!key) return null;
      if (!map.has(key)) map.set(key, { title: title || "", price: 0, description: "", photos: [], variants: [] });
      const e = map.get(key);
      if (title && !e.title) e.title = title;
      return e;
    };
    for (const r of rows) {
      const idRaw = col("id") != null ? r[col("id")] || "" : "";
      const idKey = normId(idRaw);
      const tRaw = (r[col("title")] || "").trim();
      const p = num(r[col("price")] || "");
      const category = col("category") != null ? String(r[col("category")] || "").trim() : "";
      const desc = col("description") != null ? (r[col("description")] || "").trim() : "";
      const phRaw = col("photos") != null ? r[col("photos")] || "" : "";
      const photos = phRaw.split("|").map((s) => s.trim()).filter(Boolean);
      const variantsRaw = col("variants") != null ? (r[col("variants")] || "").trim() : "";
      const iActive = col("active");
      const hasActiveCol = iActive != null;
      const aRaw = hasActiveCol ? (_a = r[iActive]) != null ? _a : "" : "";
      const isActive = (() => {
        if (!hasActiveCol) return true;
        const s = String(aRaw).trim().toLowerCase();
        if (s === "") return false;
        const YES = /* @__PURE__ */ new Set(["1", "true", "t", "да", "yes", "y", "on", "ok", "✓", "&#x2714;", "истина"]);
        const NO = /* @__PURE__ */ new Set(["0", "false", "f", "нет", "no", "n", "off", "x", "✗", "×", "-", "ложь"]);
        if (YES.has(s)) return true;
        if (NO.has(s)) return false;
        const n = Number(s.replace(",", "."));
        return !Number.isNaN(n) ? n > 0 : false;
      })();
      if (!tRaw || !p) continue;
      if (!isActive) continue;
      const hasVariant = variantsRaw && variantsRaw.trim() !== "" && variantsRaw.trim() !== "-";
      const hasChoice = hasVariant || !!category;
      const size = hasVariant ? extractSize(variantsRaw) : null;
      if (!idKey) continue;
      if (hasChoice) {
        if (!variantsByProductId.has(idKey)) {
          variantsByProductId.set(idKey, []);
        }
        variantsByProductId.get(idKey).push({
          variantText: hasVariant ? variantsRaw.trim() : category,
          size: size || "",
          category,
          price: p,
          // Цена из колонки price этой строки
          description: desc,
          photos,
          title: tRaw
        });
      } else {
        const entry = ensure(byId, idKey, tRaw);
        if (entry) {
          entry.price = p;
          entry.description = desc;
          entry.photos = photos;
          entry.variants = [];
        }
        const tKey = normCat(tRaw);
        const entryByTitle = ensure(byTitle, tKey, tRaw);
        if (entryByTitle) {
          entryByTitle.price = p;
          entryByTitle.description = desc;
          entryByTitle.photos = photos;
          entryByTitle.variants = [];
        }
      }
    }
    variantsByProductId.forEach((variantsList, idKey) => {
      let entry = byId.get(idKey);
      if (!entry) {
        const firstVariant = variantsList[0];
        entry = ensure(byId, idKey, firstVariant.title || "");
        entry.price = firstVariant.price;
        entry.description = firstVariant.description;
        entry.photos = firstVariant.photos;
        const tKey2 = normCat(firstVariant.title || "");
        const entryByTitle2 = ensure(byTitle, tKey2, firstVariant.title || "");
        entryByTitle2.price = firstVariant.price;
        entryByTitle2.description = firstVariant.description;
        entryByTitle2.photos = firstVariant.photos;
      }
      if (variantsList.length > 0) {
        entry.variants = variantsList.map((v) => ({
          variantText: v.variantText,
          // Полный текст для отображения (например, "120x40x60 (+200 ₽)")
          size: v.size,
          // Размер для отображения (например, "120х40х60")
          category: v.category || "",
          price: v.price,
          // Цена из колонки price таблицы для этого варианта
          description: v.description || entry.description,
          photos: v.photos.length > 0 ? v.photos : entry.photos
        }));
        if (!entry.price || entry.price === 0) {
          entry.price = variantsList[0].price;
        }
        if (!entry.description && variantsList[0].description) {
          entry.description = variantsList[0].description;
        }
        if (entry.photos.length === 0 && variantsList[0].photos.length > 0) {
          entry.photos = variantsList[0].photos;
        }
      }
      const tKey = normCat(entry.title);
      const entryByTitle = byTitle.get(tKey);
      if (entryByTitle && entry.variants.length > 0) {
        entryByTitle.variants = entry.variants;
      }
    });
    return { byId, byTitle };
  }

  // src/catalog/index.js
  var CAT_LABELS = ["Зелёная", "С освещением", "Заснеженная", "Заснеженная с освещением"];
  var CAT_ORDER = CAT_LABELS.map(normCat);
  var priceDict = null;
  var priceDecorDict = null;
  var KEY = "cart";
  function updatePhotos(card, catKey) {
    const want = normCat(catKey);
    const wraps = Array.from(card.querySelectorAll(IMG_WRAP_SEL));
    if (!wraps.length) {
      card.setAttribute("data-photos-ready", "");
      return;
    }
    const byCat = /* @__PURE__ */ new Map();
    wraps.forEach((w) => {
      const raw = (w.getAttribute("data-cat") || "").replace(/&quot;|&#34;/gi, '"').trim();
      byCat.set(normCat(raw), w);
    });
    let target = byCat.get(want);
    if (!target) {
      const idx = CAT_ORDER.indexOf(want);
      target = wraps[idx] || wraps[0];
    }
    const isValidSrc = (w) => {
      const img2 = w.querySelector("img");
      const src = (img2 == null ? void 0 : img2.getAttribute("data-origin-src")) || (img2 == null ? void 0 : img2.getAttribute("data-src")) || (img2 == null ? void 0 : img2.getAttribute("src")) || "";
      return !!src && src !== "/d/" && !/\/d\/?$/.test(src);
    };
    if (!isValidSrc(target)) {
      target = wraps.find(isValidSrc) || target;
    }
    wraps.forEach((w) => {
      const on = w === target;
      if (on) {
        w.removeAttribute("hidden");
        w.style.setProperty("display", "block", "important");
        w.style.removeProperty("opacity");
        w.style.removeProperty("visibility");
        const img2 = w.querySelector("img");
        if (img2) {
          const src = img2.getAttribute("data-origin-src") || img2.getAttribute("data-src");
          if (src && !img2.getAttribute("src")) img2.setAttribute("src", src);
          watchImageLoading(w, img2);
          img2.removeAttribute("hidden");
          img2.style.setProperty("display", "block", "important");
          img2.style.removeProperty("opacity");
          img2.style.removeProperty("visibility");
        }
      } else {
        w.setAttribute("hidden", "");
        w.style.setProperty("display", "none", "important");
        const img2 = w.querySelector("img");
        if (img2) {
          img2.setAttribute("hidden", "");
          img2.style.setProperty("display", "none", "important");
        }
      }
    });
    const img = target.querySelector("img");
    card.__curPhoto = (img == null ? void 0 : img.src) || "";
    const buy = card.querySelector(".buy-btn");
    if (buy) {
      if (card.__curPhoto) buy.dataset.photo = card.__curPhoto;
      else delete buy.dataset.photo;
    }
    card.setAttribute("data-photos-ready", "");
  }
  function ensureImg(w) {
    var _a;
    const holder = w.querySelector(".image") || w;
    let img = holder.querySelector("img");
    if (!img) {
      const tpl = (_a = w.closest(CARD_SEL)) == null ? void 0 : _a.querySelector(`${EXTRA_IMG_WRAP_SEL} img`);
      if (tpl) {
        img = tpl.cloneNode(false);
        img.removeAttribute("src");
        img.removeAttribute("srcset");
      } else {
        img = document.createElement("img");
        img.className = "image__img";
        img.alt = "";
        img.loading = "lazy";
        img.decoding = "async";
        img.style.width = "100%";
        img.style.height = "100%";
        img.style.objectFit = "cover";
      }
      holder.appendChild(img);
    }
    return img;
  }
  function refreshExtraPhotos(card, catKey, photoList, showAll) {
    card.querySelectorAll(`${EXTRA_IMG_WRAP_SEL}[data-extra-photo-dynamic]`).forEach((w) => w.remove());
    const wraps = Array.from(card.querySelectorAll(EXTRA_IMG_WRAP_SEL));
    if (!wraps.length) return;
    const want = normCat(catKey);
    const hasDataCat = wraps.some((w) => w.hasAttribute("data-cat"));
    const catSlots = hasDataCat ? wraps.filter((w) => w.hasAttribute("data-cat")) : wraps.slice(0, 4);
    const csvSlots = hasDataCat ? wraps.filter((w) => !w.hasAttribute("data-cat")) : wraps.slice(4);
    const urlsForCount = (photoList || []).filter(Boolean);
    if (csvSlots.length && urlsForCount.length > csvSlots.length) {
      const template = csvSlots[csvSlots.length - 1];
      let lastEl = template;
      const extraCount = urlsForCount.length - csvSlots.length;
      for (let i = 0; i < extraCount; i++) {
        const clone = template.cloneNode(true);
        clone.setAttribute("data-extra-photo-dynamic", "1");
        clone.removeAttribute("hidden");
        clone.style.removeProperty("display");
        const img = clone.querySelector("img");
        if (img) {
          img.removeAttribute("src");
          img.removeAttribute("data-origin-src");
          img.removeAttribute("srcset");
        }
        lastEl.insertAdjacentElement("afterend", clone);
        lastEl = clone;
        csvSlots.push(clone);
      }
    }
    const slotHasPhoto = (w) => {
      const img = w.querySelector("img");
      const src = (img == null ? void 0 : img.getAttribute("src")) || (img == null ? void 0 : img.getAttribute("data-origin-src")) || (img == null ? void 0 : img.getAttribute("data-src")) || "";
      return !!src && !/placeholder/i.test(src) && src !== "/d/" && !/\/d\/?$/.test(src);
    };
    if (showAll) {
      catSlots.forEach((w) => {
        w.style.display = slotHasPhoto(w) ? "" : "none";
      });
    } else {
      const byCat = /* @__PURE__ */ new Map();
      catSlots.forEach((w) => byCat.set(normCat(w.dataset.cat || ""), w));
      let target = byCat.get(want);
      if (!target) {
        const idx = Math.max(0, CAT_ORDER.indexOf(want));
        target = catSlots[idx] || null;
      }
      catSlots.forEach((w) => {
        w.style.display = w === target ? "" : "none";
      });
    }
    const urls = urlsForCount.slice(0, csvSlots.length);
    csvSlots.forEach((w, i) => {
      const url = urls[i] || "";
      if (url) {
        const img = ensureImg(w);
        img.removeAttribute("srcset");
        img.setAttribute("src", url);
        img.setAttribute("data-origin-src", url);
        watchImageLoading(w, img);
        w.style.display = "";
      } else {
        w.style.display = "none";
      }
    });
    const anyShown = catSlots.concat(csvSlots).some((w) => w.style.display !== "none");
    let section = card.querySelector("[data-extra-photos]");
    if (!section) {
      section = wraps[0].closest(".dop__img__cms");
      while (section && section.parentElement) {
        const up = section.parentElement.closest(".dop__img__cms");
        if (!up) break;
        section = up;
      }
    }
    if (section) section.style.display = anyShown ? "" : "none";
    card.setAttribute("data-photos-ready", "");
  }
  function renderDecorExtraPhotos(card, photos) {
    card.querySelectorAll(`${EXTRA_IMG_WRAP_SEL}[data-extra-photo-dynamic]`).forEach((w) => w.remove());
    const wraps = Array.from(card.querySelectorAll(EXTRA_IMG_WRAP_SEL));
    if (!wraps.length) return;
    const list = (photos || []).filter(Boolean);
    if (list.length > wraps.length) {
      const template = wraps[wraps.length - 1];
      let lastEl = template;
      for (let i = 0; i < list.length - wraps.length; i++) {
        const clone = template.cloneNode(true);
        clone.setAttribute("data-extra-photo-dynamic", "1");
        clone.removeAttribute("hidden");
        clone.style.removeProperty("display");
        const img = clone.querySelector("img");
        if (img) {
          img.removeAttribute("src");
          img.removeAttribute("data-origin-src");
          img.removeAttribute("srcset");
        }
        lastEl.insertAdjacentElement("afterend", clone);
        lastEl = clone;
        wraps.push(clone);
      }
    }
    wraps.forEach((w, i) => {
      const url = list[i] || "";
      if (url) {
        const img = ensureImg(w);
        img.removeAttribute("srcset");
        img.setAttribute("src", url);
        img.setAttribute("data-origin-src", url);
        watchImageLoading(w, img);
        w.style.display = "";
      } else {
        w.style.display = "none";
      }
    });
    const anyShown = wraps.some((w) => w.style.display !== "none");
    let section = card.querySelector("[data-extra-photos]");
    if (!section) {
      section = wraps[0].closest(".dop__img__cms");
      while (section && section.parentElement) {
        const up = section.parentElement.closest(".dop__img__cms");
        if (!up) break;
        section = up;
      }
    }
    if (section) section.style.display = anyShown ? "" : "none";
  }
  var setText = (el, txt) => {
    var _a;
    (((_a = el == null ? void 0 : el.querySelector) == null ? void 0 : _a.call(el, ".text-block-wrap-div")) || el).textContent = txt;
  };
  function watchImageLoading(wrapper, img) {
    if (!wrapper || !img) return;
    const finish = () => wrapper.classList.remove("le-image-skeleton");
    const fail = () => {
      img.setAttribute("hidden", "");
      img.style.setProperty("display", "none", "important");
      finish();
    };
    wrapper.classList.add("le-image-skeleton");
    img.addEventListener("load", finish, { once: true });
    img.addEventListener("error", fail, { once: true });
    if (img.complete && img.naturalWidth > 0) finish();
  }
  function markPricesLoading() {
    $$(CARD_SEL).forEach((card) => {
      card.querySelectorAll("[data-price-decor], .price").forEach((priceEl) => {
        setText(priceEl, "Загрузка...");
      });
    });
  }
  function isDecorCard(card) {
    return !!card.querySelector("[data-product-id-decor]") || !!card.querySelector("[data-variants-decor]") && !card.querySelector("[data-prop-category]") && !card.querySelector("[data-prop-height]");
  }
  function neededPriceFeeds(cards, cart) {
    const need = { trees: false, decor: false };
    cards.forEach((card) => {
      need[isDecorCard(card) ? "decor" : "trees"] = true;
    });
    if (Array.isArray(cart)) cart.forEach((item) => {
      need[String((item == null ? void 0 : item.category) || "").trim() === "Декор" ? "decor" : "trees"] = true;
    });
    return need;
  }
  function routePriceFeeds(pathname) {
    return {
      trees: /^\/(?:catalog(?:\/|$)|tree(?:\/|$))/.test(pathname),
      decor: /^\/catalog-(?:tree|decor)(?:\/|$)/.test(pathname)
    };
  }
  async function loadNeededPriceFeeds(need, cache = "default") {
    const results = await Promise.allSettled([
      need.trees ? loadDict(cache) : Promise.resolve(null),
      need.decor ? loadDecorDict(cache) : Promise.resolve(null)
    ]);
    const [trees, decor] = results;
    if (trees.status === "fulfilled" && trees.value) {
      priceDict = trees.value;
      console.log("Таблица елок загружена, записей:", priceDict.byId.size + priceDict.byTitle.size);
    } else if (trees.status === "rejected") console.error("таблица елок не загрузилась", trees.reason);
    if (decor.status === "fulfilled" && decor.value) {
      priceDecorDict = decor.value;
      console.log("Таблица декора загружена, записей:", priceDecorDict.byId.size + priceDecorDict.byTitle.size);
    } else if (decor.status === "rejected") console.error("таблица декора не загрузилась", decor.reason);
    return { dict: trees.status === "fulfilled" ? trees.value : null, decorDict: decor.status === "fulfilled" ? decor.value : null };
  }
  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]);
  }
  function setHtmlWithNewlines(el, text) {
    var _a;
    const target = ((_a = el == null ? void 0 : el.querySelector) == null ? void 0 : _a.call(el, ".text-block-wrap-div")) || el;
    target.innerHTML = escapeHtml(text || "").replace(/\n/g, "<br>");
  }
  function ensureList(holder, role) {
    if (!holder) return null;
    holder.style.position = holder.style.position || "relative";
    let list = holder.querySelector("[data-dd-list]");
    if (!list) {
      list = document.createElement("div");
      list.setAttribute("data-dd-list", role || "");
      Object.assign(list.style, {
        position: "absolute",
        display: "none",
        left: "0",
        right: "0",
        zIndex: "50",
        background: "#fff",
        boxShadow: "0 8px 18px rgba(0,0,0,.08)",
        borderRadius: "10px",
        overflowY: "auto",
        maxHeight: "280px"
      });
      holder.appendChild(list);
    }
    return list;
  }
  function openDD(holder, list) {
    const card = holder.closest(CARD_SEL) || holder;
    const hr = holder.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const spaceBelow = Math.max(0, cr.bottom - hr.bottom - 8);
    const spaceAbove = Math.max(0, hr.top - cr.top - 8);
    list.style.removeProperty("bottom");
    list.style.top = "100%";
    let side = "down", avail = spaceBelow;
    if (spaceAbove > spaceBelow) {
      side = "up";
      list.style.removeProperty("top");
      list.style.bottom = "100%";
      avail = spaceAbove;
    }
    const maxH = Math.max(140, Math.min(280, avail));
    list.style.maxHeight = maxH + "px";
    list.style.display = "";
    holder.classList.add("dd-open");
    if (avail < 60) {
      list.style.maxHeight = "160px";
      if (side === "down") {
        list.style.top = "calc(100% + 6px)";
      } else {
        list.style.bottom = "calc(100% + 6px)";
      }
    }
  }
  var ddListsCache = null;
  var ddOpenCache = null;
  function closeAllDD() {
    if (!ddListsCache || !ddListsCache.length) {
      ddListsCache = Array.from(document.querySelectorAll("[data-dd-list]"));
    }
    if (!ddOpenCache || !ddOpenCache.length) {
      ddOpenCache = Array.from(document.querySelectorAll(".dd-open"));
    }
    ddListsCache.forEach((el) => {
      if (el.style.display !== "none") el.style.display = "none";
    });
    ddOpenCache.forEach((el) => {
      if (el.classList.contains("dd-open")) el.classList.remove("dd-open");
    });
    ddListsCache = null;
    ddOpenCache = null;
  }
  document.addEventListener("click", (e) => {
    if (!e.target.closest("[data-dd-list],[data-prop-category],[data-prop-height],.input__catalog,[data-variants-decor]")) {
      closeAllDD();
    }
  });
  function attachHover(listEl) {
    listEl.querySelectorAll("[data-dd-option] .site__h5").forEach((span) => {
      const btn = span.closest("[data-dd-option]");
      btn.addEventListener("mouseenter", () => {
        span.classList.remove("color__h3");
        span.classList.add("color__h2");
      });
      btn.addEventListener("mouseleave", () => {
        span.classList.remove("color__h2");
        span.classList.add("color__h3");
      });
    });
  }
  function getCsvPhotos(entry, catKey) {
    var _a;
    const arr = ((_a = entry == null ? void 0 : entry.cats) == null ? void 0 : _a.get(catKey)) || [];
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const o of arr) {
      for (const u of o.photos || []) {
        const s = String(u || "").trim();
        if (!s) continue;
        if (s === "/d/" || /\/d\/?$/.test(s)) continue;
        if (!seen.has(s)) {
          seen.add(s);
          out.push(s);
        }
      }
    }
    return out;
  }
  function selectVariant(card, variantsDecorEl, entry, variantIndex) {
    if (!entry.variants || !entry.variants[variantIndex]) return;
    const variant = entry.variants[variantIndex];
    const variantPrice = variant.price || entry.price || 0;
    const variantSize = variant.size || "";
    const sizeTextEl = variantsDecorEl.querySelector(".text.site-catalog__h3, .site-catalog__h3");
    if (sizeTextEl) {
      setText(sizeTextEl, variantSize);
    }
    const hTextEl = card.querySelector("[data-prop-height]");
    if (hTextEl) {
      setText(hTextEl, variantSize);
      const hLabel = hTextEl.closest(".input__catalog") || hTextEl;
      if (hLabel) {
        hLabel.style.display = "";
      }
    }
    const priceFormatted = rub(variantPrice);
    const priceDecorEl = card.querySelector("[data-price-decor]");
    if (priceDecorEl) {
      setText(priceDecorEl, priceFormatted);
      const textEl = priceDecorEl.querySelector(".text-block-wrap-div");
      if (textEl) {
        textEl.textContent = priceFormatted;
      } else {
        priceDecorEl.textContent = priceFormatted;
      }
    }
    const buyBtn = card.querySelector(".buy-btn");
    if (buyBtn) {
      buyBtn.dataset.price = variantPrice;
      buyBtn.dataset.height = variantSize;
    }
    variantsDecorEl.dataset.selectedIndex = variantIndex;
    variantsDecorEl.classList.remove("dd-open");
  }
  function initDecorCard(card, entry, titleEl, titleNow) {
    var _a;
    const sheetTitle = entry.title || titleNow;
    if (titleEl && sheetTitle && sheetTitle !== titleNow) {
      (((_a = titleEl.querySelector) == null ? void 0 : _a.call(titleEl, ".text-block-wrap-div")) || titleEl).textContent = sheetTitle;
    }
    const priceEl = card.querySelector("[data-price-decor]");
    const buy = card.querySelector(".buy-btn");
    const image = card.querySelector(".product__img img, .product__img__cms img, .image__img, img");
    const descriptionEl = card.querySelector(".text--u-ibls00792, [data-product-id].text--u-ibls00792");
    const sizeControl = card.querySelector("[data-variants-decor]");
    const allVariants = entry.variants || [];
    const types = [...new Set(allVariants.map((v) => String(v.category || "").trim()).filter(Boolean))];
    const setImage = (variant) => {
      var _a2;
      const photos = (((_a2 = variant == null ? void 0 : variant.photos) == null ? void 0 : _a2.length) ? variant.photos : entry.photos) || [];
      const photo = photos[0] || "";
      if (image && photo) {
        image.src = photo;
        image.setAttribute("data-origin-src", photo);
        image.classList.add("can-zoom");
      }
      renderDecorExtraPhotos(card, photos.slice(1));
    };
    const setDescription = (variant) => {
      if (!descriptionEl) return;
      const text = ((variant == null ? void 0 : variant.description) || entry.description || "").trim();
      const target = descriptionEl.querySelector(".text-block-wrap-div") || descriptionEl;
      setHtmlWithNewlines(target, text);
      descriptionEl.style.display = text ? "" : "none";
    };
    const setPriceAndBuy = (variant) => {
      var _a2, _b;
      const price = (variant == null ? void 0 : variant.price) || entry.price || 0;
      if (priceEl) setText(priceEl, rub(price));
      if (!buy) return;
      buy.dataset.name = sheetTitle;
      buy.dataset.price = price;
      buy.dataset.photo = ((_a2 = variant == null ? void 0 : variant.photos) == null ? void 0 : _a2[0]) || ((_b = entry.photos) == null ? void 0 : _b[0]) || "";
      buy.dataset.category = "Декор";
      buy.dataset.height = (variant == null ? void 0 : variant.size) || "";
      buy.dataset.diam = "";
      buy.dataset.branches = "";
    };
    const setControlText = (control, text) => {
      const target = control == null ? void 0 : control.querySelector(".text.site-catalog__h3, .site-catalog__h3");
      if (target) setText(target, text);
    };
    const bindControl = (control, values, label, onSelect) => {
      if (!control) return;
      const list = ensureList(control, control.hasAttribute("data-decor-type") ? "decor-type" : "variants-decor");
      list.innerHTML = "";
      values.forEach((value, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("data-dd-option", "");
        button.style.cssText = "display:block;width:100%;text-align:left;padding:10px 12px;border:0;background:transparent;cursor:pointer";
        const span = document.createElement("span");
        span.className = "site__h5 color__h3";
        span.textContent = label(value);
        button.appendChild(span);
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          onSelect(value, index);
          closeAllDD();
        });
        list.appendChild(button);
      });
      control.onclick = (event) => {
        if (event.target.closest("[data-dd-option]")) return;
        event.stopPropagation();
        const open = list.style.display !== "none" && list.style.display !== "" && control.classList.contains("dd-open");
        closeAllDD();
        if (!open) openDD(control, list);
      };
      control.style.position = "relative";
      control.style.cursor = "pointer";
      control.style.userSelect = "none";
      attachHover(list);
    };
    let typeControl = card.querySelector("[data-decor-type]");
    if (types.length > 1 && sizeControl && !typeControl) {
      typeControl = sizeControl.cloneNode(true);
      typeControl.removeAttribute("data-variants-decor");
      typeControl.removeAttribute("data-variants");
      typeControl.removeAttribute("data-selected-index");
      typeControl.setAttribute("data-decor-type", "");
      typeControl.querySelectorAll("[data-dd-list]").forEach((node) => node.remove());
      typeControl.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
      typeControl.removeAttribute("id");
      sizeControl.parentNode.insertBefore(typeControl, sizeControl);
    }
    const showRow = (el) => el && el.style.setProperty("display", "flex", "important");
    const hideRow = (el) => el && el.style.setProperty("display", "none", "important");
    const renderType = (type) => {
      const variants = type ? allVariants.filter((v) => String(v.category || "").trim() === type) : allVariants;
      const first = variants[0] || null;
      setDescription(first);
      setImage(first);
      setPriceAndBuy(first);
      if (typeControl) {
        setControlText(typeControl, type);
        (types.length > 1 ? showRow : hideRow)(typeControl);
      }
      if (!sizeControl) return;
      const needsSize = variants.length > 1 || !!(first == null ? void 0 : first.size);
      (needsSize ? showRow : hideRow)(sizeControl);
      if (!needsSize) return;
      setControlText(sizeControl, (first == null ? void 0 : first.size) || (first == null ? void 0 : first.variantText) || "Выберите размер");
      bindControl(sizeControl, variants, (variant) => variant.variantText || variant.size || "Вариант", (variant) => {
        setControlText(sizeControl, variant.size || variant.variantText || "Вариант");
        setDescription(variant);
        setImage(variant);
        setPriceAndBuy(variant);
        sizeControl.classList.remove("dd-open");
      });
    };
    if (typeControl) bindControl(typeControl, types, (type) => type, (type) => renderType(type));
    renderType(types[0] || "");
  }
  (async function initCards() {
    const toId = (s) => String(s || "").trim().toLowerCase();
    const savedCart = getCart();
    const earlyFeeds = routePriceFeeds(window.location.pathname);
    const earlyPrices = loadNeededPriceFeeds(earlyFeeds);
    if (document.readyState === "loading") {
      await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
    }
    const cards = $$(CARD_SEL);
    markPricesLoading();
    const neededFeeds = neededPriceFeeds(cards, []);
    if (!neededFeeds.trees && !neededFeeds.decor) return;
    const early = await earlyPrices;
    const extraFeeds = {
      trees: neededFeeds.trees && !earlyFeeds.trees,
      decor: neededFeeds.decor && !earlyFeeds.decor
    };
    const extra = extraFeeds.trees || extraFeeds.decor ? await loadNeededPriceFeeds(extraFeeds) : { dict: null, decorDict: null };
    const dict = early.dict || extra.dict;
    const decorDict = early.decorDict || extra.decorDict;
    if (!dict && !decorDict) {
      console.warn("Ни одна таблица не загрузилась");
      return;
    }
    cards.forEach((card) => {
      var _a, _b, _c, _d, _e;
      if (card.__inited) return;
      card.__inited = true;
      card.querySelectorAll("select.category-select, select.height-select").forEach((el) => el.remove());
      const buy = card.querySelector(".buy-btn");
      if (!buy) return;
      const idBlockDecor = card.querySelector("[data-product-id-decor]");
      const idBlock = card.querySelector("[data-product-id]");
      let pid = "";
      if (idBlockDecor) {
        pid = (idBlockDecor.getAttribute("data-product-id-decor") || idBlockDecor.textContent || "").trim();
        if (!pid || pid === "") {
          const idText = ((_a = idBlockDecor.querySelector(".text-block-wrap-div")) == null ? void 0 : _a.textContent) || idBlockDecor.textContent || "";
          pid = idText.trim();
        }
        idBlockDecor.style.display = "none";
      } else if (idBlock) {
        pid = (idBlock.getAttribute("data-product-id") || idBlock.textContent || "").trim();
        idBlock.style.display = "none";
      }
      if (!pid) {
        pid = (card.getAttribute("data-product-id") || card.getAttribute("data-id") || "").trim();
      }
      const titleEl = card.querySelector("[data-prop-title] .text-block-wrap-div, [data-prop-title]");
      const titleNow = ((titleEl == null ? void 0 : titleEl.textContent) || "").trim();
      const catTextEl = card.querySelector("[data-prop-category]");
      const hTextEl = card.querySelector("[data-prop-height]");
      const variantsDecorEl = card.querySelector("[data-variants-decor]");
      const isDecor = isDecorCard(card);
      if (isDecor) {
        if (!decorDict) return;
        const { byId: decorById, byTitle: decorByTitle } = decorDict;
        let entry2 = pid ? decorById.get(toId(pid)) : null;
        if (!entry2) entry2 = decorByTitle.get(norm(titleNow));
        if (!entry2) {
          console.warn("нет активных строк для декора", pid || titleNow);
          return;
        }
        initDecorCard(card, entry2, titleEl, titleNow);
        return;
        const sheetTitle2 = entry2.title || titleNow;
        if (titleEl && sheetTitle2 && sheetTitle2 !== titleNow) {
          (((_b = titleEl.querySelector) == null ? void 0 : _b.call(titleEl, ".text-block-wrap-div")) || titleEl).textContent = sheetTitle2;
        }
        const descEl2 = card.querySelector(".text--u-ibls00792, [data-product-id].text--u-ibls00792");
        if (descEl2 && entry2.description) {
          const descSpan = descEl2.querySelector(".text-block-wrap-div") || descEl2;
          setHtmlWithNewlines(descSpan, entry2.description);
        }
        const priceDecorEl = card.querySelector("[data-price-decor]");
        if (priceDecorEl) {
          const initialPrice = entry2.variants && entry2.variants.length > 0 ? entry2.variants[0].price || entry2.price : entry2.price;
          setText(priceDecorEl, rub(initialPrice));
          const textEl = priceDecorEl.querySelector(".text-block-wrap-div");
          if (textEl) {
            textEl.textContent = rub(initialPrice);
          }
        }
        const pic2 = card.querySelector(".product__img img, .product__img__cms img, .image__img, img");
        const photo2 = (pic2 == null ? void 0 : pic2.getAttribute("data-origin-src")) || (pic2 == null ? void 0 : pic2.currentSrc) || (pic2 == null ? void 0 : pic2.src) || "";
        const variantsDecorEl2 = card.querySelector("[data-variants-decor]");
        const hTextEl2 = card.querySelector("[data-prop-height]");
        const hasVariants = variantsDecorEl2 && entry2.variants && entry2.variants.length > 0;
        if (hasVariants) {
          const firstVariant = entry2.variants[0];
          const initialSize = firstVariant.size || "";
          if (hTextEl2) {
            const hLabel2 = hTextEl2.closest(".input__catalog") || hTextEl2;
            if (hLabel2) {
              hLabel2.style.display = "";
            }
            setText(hTextEl2, initialSize);
          }
          const initialPrice = entry2.variants[0].price || entry2.price;
          buy.dataset.name = sheetTitle2;
          buy.dataset.price = initialPrice;
          buy.dataset.photo = photo2;
          buy.dataset.category = "Декор";
          buy.dataset.height = initialSize;
          buy.dataset.diam = "";
          buy.dataset.branches = "";
        } else {
          if (hTextEl2) {
            const hLabel2 = hTextEl2.closest(".input__catalog") || hTextEl2;
            if (hLabel2) {
              hLabel2.style.display = "none";
            }
          }
          buy.dataset.name = sheetTitle2;
          buy.dataset.price = entry2.price;
          buy.dataset.photo = photo2;
          buy.dataset.category = "Декор";
          buy.dataset.height = "";
          buy.dataset.diam = "";
          buy.dataset.branches = "";
        }
        if (hasVariants) {
          variantsDecorEl2.style.setProperty("display", "flex", "important");
          variantsDecorEl2.style.position = "relative";
          variantsDecorEl2.style.cursor = "pointer";
          variantsDecorEl2.style.userSelect = "none";
          variantsDecorEl2.dataset.variants = JSON.stringify(entry2.variants);
          variantsDecorEl2.dataset.selectedIndex = "0";
          const firstVariant = entry2.variants[0];
          const sizeTextEl = variantsDecorEl2.querySelector(".text.site-catalog__h3, .site-catalog__h3");
          if (sizeTextEl && firstVariant.size) {
            setText(sizeTextEl, firstVariant.size);
          }
          const list = ensureList(variantsDecorEl2, "variants-decor");
          if (list) {
            list.innerHTML = "";
            entry2.variants.forEach((variant, index) => {
              const button = document.createElement("button");
              button.type = "button";
              button.setAttribute("data-dd-option", "");
              button.setAttribute("data-variant-index", index);
              button.style.cssText = "display:block;width:100%;text-align:left;padding:10px 12px;border:0;background:transparent;cursor:pointer";
              const span = document.createElement("span");
              span.className = "site__h5 color__h3";
              const label = variant.variantText || variant.size || "";
              span.textContent = label;
              button.appendChild(span);
              button.addEventListener("click", (e) => {
                e.stopPropagation();
                selectVariant(card, variantsDecorEl2, entry2, index);
                closeAllDD();
              });
              list.appendChild(button);
            });
            attachHover(list);
          }
          variantsDecorEl2.addEventListener("click", (e) => {
            if (e.target.closest("[data-dd-option]")) {
              return;
            }
            e.stopPropagation();
            const list2 = variantsDecorEl2.querySelector("[data-dd-list]");
            if (list2) {
              const isCurrentlyOpen = list2.style.display !== "none" && list2.style.display !== "" && variantsDecorEl2.classList.contains("dd-open");
              closeAllDD();
              if (!isCurrentlyOpen) {
                openDD(variantsDecorEl2, list2);
              }
            }
          });
        }
        return;
      }
      if (!dict) {
        console.warn("Таблица елок не загружена, пропускаем карточку:", titleNow);
        return;
      }
      if (!catTextEl || !hTextEl) {
        console.warn("У карточки нет data-prop-category или data-prop-height:", titleNow, {
          hasCategory: !!catTextEl,
          hasHeight: !!hTextEl
        });
        return;
      }
      const { byId, byTitle } = dict;
      let entry = pid ? byId.get(toId(pid)) : null;
      if (!entry) entry = byTitle.get(norm(titleNow));
      if (!entry) {
        console.warn("нет активных строк для карточки", pid || titleNow, "byId size:", byId.size, "byTitle size:", byTitle.size);
        hideCard(card);
        return;
      }
      console.log("Найдена запись для карточки:", titleNow, "категорий:", entry.cats.size);
      const sheetTitle = entry.title || titleNow;
      if (titleEl && sheetTitle && sheetTitle !== titleNow) {
        (((_c = titleEl.querySelector) == null ? void 0 : _c.call(titleEl, ".text-block-wrap-div")) || titleEl).textContent = sheetTitle;
      }
      const descEl = card.querySelector("[data-prop-description]");
      const setDescForCategory = (catKey) => {
        var _a2;
        if (!descEl) return;
        const list = entry.cats.get(catKey) || [];
        const txt = (((_a2 = list[0]) == null ? void 0 : _a2.description) || entry.description || "").trim();
        const wrap = descEl.closest(".item-desc") || descEl;
        if (txt) {
          setHtmlWithNewlines(descEl, txt);
          wrap.style.display = "";
        } else {
          setHtmlWithNewlines(descEl, "");
          wrap.style.display = "none";
        }
      };
      const catLabel = catTextEl.closest(".input__catalog") || catTextEl;
      const hLabel = hTextEl.closest(".input__catalog") || hTextEl;
      const priceNode = card.querySelector(".price .text-block-wrap-div") || card.querySelector(".price");
      const diamEl = card.querySelector("[data-prop-diam]");
      const brEl = card.querySelector("[data-prop-branches]");
      const oldEl = card.querySelector("[data-prop-offer]");
      const discEl = card.querySelector("[data-prop-discount]");
      const pic = card.querySelector(".product__img img, .product__img__cms img, .image__img, img");
      const photo = (pic == null ? void 0 : pic.getAttribute("data-origin-src")) || (pic == null ? void 0 : pic.currentSrc) || (pic == null ? void 0 : pic.src) || "";
      const cats = entry.cats;
      const catKeys = [...cats.keys()];
      if (catKeys.length === 0) {
        hideCard(card);
        return;
      }
      const ord = (k) => {
        const i = CAT_ORDER.indexOf(normCat(k));
        return i >= 0 ? i : 100 + catKeys.indexOf(k);
      };
      const catKeysOrdered = catKeys.slice().sort((a, b) => ord(a) - ord(b));
      const singleCategory = catKeysOrdered.length <= 1;
      let curCatKey = (() => {
        const def = normCat(catTextEl.textContent || "");
        return catKeys.includes(def) ? def : catKeysOrdered[0];
      })();
      let curCatText = ((_e = (_d = cats.get(curCatKey)) == null ? void 0 : _d[0]) == null ? void 0 : _e.category) || (catTextEl.textContent || "").trim() || "Категория";
      setText(catTextEl, curCatText);
      const catList = ensureList(catLabel, "category");
      const hList = ensureList(hLabel, "height");
      [catLabel, hLabel].forEach((el) => {
        el.style.cursor = "pointer";
        el.style.userSelect = "none";
      });
      catList.innerHTML = catKeysOrdered.map((k) => {
        var _a2, _b2;
        const t = ((_b2 = (_a2 = cats.get(k)) == null ? void 0 : _a2[0]) == null ? void 0 : _b2.category) || k;
        return `<button type="button" data-dd-option data-cat="${k}"
                style="display:block;width:100%;text-align:left;padding:10px 12px;border:0;background:transparent;cursor:pointer">
                <span class="site__h5 color__h3">${t}</span>
              </button>`;
      }).join("");
      attachHover(catList);
      if (singleCategory) {
        catLabel.style.display = "none";
      }
      function renderHeights() {
        const list = cats.get(curCatKey) || [];
        if (!list.length) {
          hList.innerHTML = "";
          setText(hTextEl, "—");
          return;
        }
        hList.innerHTML = list.map((o) => `
        <button type="button" data-dd-option
          data-height="${o.height}" data-price="${o.price}"
          data-d="${o.diam}" data-b="${o.branches}"
          data-offer="${o.offer}" data-discount="${o.discount}"
          style="display:block;width:100%;text-align:left;padding:10px 12px;border:0;background:transparent;cursor:pointer">
          <span class="site__h5 color__h3">${o.height} см</span>
        </button>`).join("");
        attachHover(hList);
        if (list[0]) {
          applySize(list[0]);
        } else {
          console.warn("Нет данных для применения размера для карточки", sheetTitle);
        }
      }
      function applySize(o) {
        if (!o) {
          console.warn("applySize вызван с некорректными данными:", o, "для карточки", sheetTitle);
          return;
        }
        buy.dataset.name = sheetTitle;
        buy.dataset.height = o.height || "";
        buy.dataset.price = o.price || 0;
        if (card.__curPhoto) buy.dataset.photo = card.__curPhoto;
        buy.dataset.category = curCatText;
        buy.dataset.diam = o.diam || "";
        buy.dataset.branches = o.branches || "";
        if (priceNode) setText(priceNode, rub(o.price));
        const setProp = (el, val, suffix) => {
          if (!el) return;
          const line = el.closest(".list__item") || el;
          if (val) {
            setText(el, `${val} ${suffix}`);
            line.style.display = "";
          } else {
            setText(el, "");
            if (line !== el) line.style.display = "none";
          }
        };
        setProp(diamEl, o.diam, "см");
        setProp(brEl, o.branches, "шт.");
        setText(hTextEl, `${o.height} см`);
        if (oldEl) {
          let off = num(o.offer || 0);
          const pNow = num(o.price || 0);
          const pct = Math.abs(Number(o.discount || 0));
          if (!off && pNow && pct > 0 && pct < 100) off = Math.round(pNow / (1 - pct / 100));
          if (off > 0) {
            setText(oldEl, rub(off));
            oldEl.style.display = "";
          } else {
            setText(oldEl, "");
            oldEl.style.display = "none";
          }
        }
        if (discEl) {
          let pct = Math.abs(Number(o.discount || 0));
          if (!pct) {
            const pNow = num(o.price || 0), off = num(o.offer || 0);
            if (pNow && off && off > pNow) pct = Math.round((1 - pNow / off) * 100);
          }
          setText(discEl, pct ? `-${pct}%` : "");
        }
      }
      if (!singleCategory) catLabel.addEventListener("click", (e) => {
        if (e.target.closest("[data-dd-option]")) return;
        const shown = catList.style.display !== "none";
        closeAllDD();
        if (!shown) openDD(catLabel, catList);
      });
      hLabel.addEventListener("click", (e) => {
        if (e.target.closest("[data-dd-option]")) return;
        const shown = hList.style.display !== "none";
        closeAllDD();
        if (!shown) openDD(hLabel, hList);
      });
      catList.addEventListener("click", (e) => {
        var _a2, _b2;
        const btn = e.target.closest("[data-dd-option]");
        if (!btn) return;
        curCatKey = btn.dataset.cat;
        curCatText = ((_b2 = (_a2 = cats.get(curCatKey)) == null ? void 0 : _a2[0]) == null ? void 0 : _b2.category) || curCatText;
        setText(catTextEl, curCatText);
        catList.style.display = "none";
        catLabel.classList.remove("dd-open");
        renderHeights();
        updatePhotos(card, curCatKey);
        const phList = getCsvPhotos(entry, curCatKey);
        refreshExtraPhotos(card, curCatKey, phList, singleCategory);
        setDescForCategory(curCatKey);
      });
      hList.addEventListener("click", (e) => {
        const b = e.target.closest("[data-dd-option]");
        if (!b) return;
        applySize({
          height: num(b.dataset.height),
          price: num(b.dataset.price),
          diam: num(b.dataset.d),
          branches: num(b.dataset.b),
          offer: num(b.dataset.offer),
          discount: num(b.dataset.discount)
        });
        hList.style.display = "none";
        hLabel.classList.remove("dd-open");
      });
      renderHeights();
      updatePhotos(card, curCatKey);
      const phList0 = getCsvPhotos(entry, curCatKey);
      refreshExtraPhotos(card, curCatKey, phList0, singleCategory);
      setDescForCategory(curCatKey);
    });
    if (savedCart.length) refreshPriceDicts().then(() => {
      try {
        if (revalidateCartPrices(getCart()).changed) {
          console.log("Цены в сохранённой корзине обновлены до актуальных");
        }
      } catch (e) {
        console.warn("не удалось обновить цены сохранённой корзины", e);
      }
    });
  })();
  var popup = document.querySelector("[data-cart-popup]");
  function getCart() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "[]");
    } catch {
      return [];
    }
  }
  function setCart(arr) {
    try {
      localStorage.setItem(KEY, JSON.stringify(arr || []));
    } catch {
    }
  }
  window.getCart = getCart;
  window.setCart = setCart;
  window.updateCartTotal = updateCartTotal;
  function getItemId(item) {
    const height = String(item.height || "").trim();
    const category = String(item.category || "").trim();
    const name = (item.name || "").trim();
    if (category === "Декор") {
      if (height && height !== "") {
        return `${name}_${category}_${height}`;
      } else {
        return `${name}_${category}`;
      }
    }
    return `${name}_${height}_${category}`;
  }
  function refreshPriceDicts() {
    return loadNeededPriceFeeds(neededPriceFeeds([], getCart()), "no-store");
  }
  function syncCartPricesAndRender() {
    return refreshPriceDicts().then(() => {
      const cart = getCart();
      if (!revalidateCartPrices(cart).changed) return false;
      try {
        popupCache.lastUpdate = 0;
        itemElementsCache = /* @__PURE__ */ new WeakMap();
        fillPopup();
        updateCartTotal();
        if (typeof window.LE_Promo !== "undefined" && window.LE_Promo.render) window.LE_Promo.render();
      } catch (e) {
        console.warn("не удалось перерисовать корзину после обновления цен", e);
      }
      return true;
    });
  }
  function revalidateCartPrices(cart) {
    if (!Array.isArray(cart) || !cart.length) return { changed: false, raised: false };
    const freshDict = priceDict;
    const freshDecorDict = priceDecorDict;
    if (!freshDict && !freshDecorDict) return { changed: false, raised: false };
    let changed = false;
    let raised = false;
    cart.forEach((item) => {
      var _a;
      const isDecor = String(item.category || "").trim() === "Декор";
      const src = isDecor ? freshDecorDict : freshDict;
      if (!src) return;
      const tKey = norm(item.name || "");
      const entry = src.byTitle.get(tKey) || src.byTitle.get(normCat(item.name || ""));
      if (!entry) return;
      let freshPrice = 0;
      if (isDecor) {
        const variants = entry.variants || [];
        if (variants.length) {
          const v = variants.find((o) => String(o.size) === String(item.height)) || (variants.length === 1 ? variants[0] : null);
          if (!v) return;
          freshPrice = num(v.price || 0);
        } else {
          freshPrice = num(entry.price || 0);
        }
      } else {
        const list = (_a = entry.cats) == null ? void 0 : _a.get(normCat(item.category || ""));
        if (!list || !list.length) return;
        const match = list.find((o) => String(o.height) === String(item.height)) || (list.length === 1 ? list[0] : null);
        if (!match) return;
        freshPrice = num(match.price || 0);
      }
      const oldPrice = num(item.price || 0);
      if (freshPrice > 0 && freshPrice !== oldPrice) {
        console.log("Цена товара обновлена перед оплатой:", item.name, oldPrice, "->", freshPrice);
        item.price = freshPrice;
        if (typeof item.basePrice === "number") item.basePrice = freshPrice;
        changed = true;
        if (freshPrice > oldPrice) raised = true;
      }
    });
    if (changed) {
      try {
        setCart(cart);
      } catch (e) {
      }
    }
    return { changed, raised };
  }
  function addToCart(item) {
    const cart = getCart();
    const itemId = getItemId(item);
    const existing = cart.findIndex((it) => getItemId(it) === itemId);
    if (existing >= 0) {
      cart[existing].qty = (cart[existing].qty || 1) + 1;
    } else {
      cart.push({ ...item, qty: 1, id: itemId });
    }
    setCart(cart);
  }
  function restoreScroll() {
    try {
      if (document.body) {
        document.body.classList.remove("no-scroll", "overflow-hidden", "lock-scroll", "scroll-lock", "modal-open");
        const bodyStyle = document.body.getAttribute("style");
        if (bodyStyle && (bodyStyle.includes("overflow") || bodyStyle.includes("position:fixed"))) {
          const styleObj = {};
          const styles = bodyStyle.split(";").filter((s) => s.trim());
          styles.forEach((s) => {
            const [prop, val] = s.split(":").map((x) => x.trim());
            if (prop && val && !["overflow", "overflowY", "overflowX", "position"].includes(prop.toLowerCase())) {
              styleObj[prop] = val;
            }
          });
          const newStyle = Object.entries(styleObj).map(([k, v]) => `${k}: ${v}`).join("; ");
          if (newStyle) {
            document.body.setAttribute("style", newStyle);
          } else {
            document.body.removeAttribute("style");
          }
        }
        document.body.style.overflow = "";
        document.body.style.overflowY = "";
        document.body.style.overflowX = "";
        if (document.body.style.position === "fixed") {
          document.body.style.position = "";
        }
      }
      if (document.documentElement) {
        document.documentElement.classList.remove("no-scroll", "overflow-hidden", "lock-scroll", "scroll-lock", "modal-open");
        document.documentElement.style.overflow = "";
        document.documentElement.style.overflowY = "";
        document.documentElement.style.overflowX = "";
        if (document.documentElement.style.position === "fixed") {
          document.documentElement.style.position = "";
        }
      }
      const containers = document.querySelectorAll('html, body, main, [role="main"]');
      containers.forEach((el) => {
        if (el && el.style) {
          if (el.style.overflow === "hidden" || el.style.overflowY === "hidden") {
            el.style.overflow = "";
            el.style.overflowY = "";
          }
          if (el.style.position === "fixed") {
            el.style.position = "";
          }
        }
      });
      try {
        window.scrollTo(0, window.scrollY);
      } catch (e) {
      }
    } catch (e) {
      console.warn("restoreScroll error:", e);
    }
  }
  function removeFromCart(itemId) {
    const cart = getCart();
    const filtered = cart.filter((it) => getItemId(it) !== itemId);
    setCart(filtered);
    if (filtered.length === 0) {
      try {
        localStorage.removeItem("lady_promo_state");
        const promoInput = document.querySelector("[data-promo-input]");
        if (promoInput) promoInput.value = "";
        if (totalOfferCache) {
          setText(totalOfferCache, "");
          const offerEl = totalOfferCache.closest("[data-cart-sum-offer]");
          if (offerEl && offerEl.style) offerEl.style.display = "none";
        }
      } catch (e) {
      }
      if (popupCache.firstItem) {
        popupCache.firstItem.removeAttribute("data-cart-item");
        popupCache.firstItem.style.display = "none";
        const photoEl = popupCache.firstItem.querySelector("[data-cart-photo] img");
        if (photoEl) photoEl.src = "";
        const titleEl = popupCache.firstItem.querySelector("[data-cart-title] .text-block-wrap-div");
        if (titleEl) titleEl.textContent = "Наименование товара";
        const categoryEl = popupCache.firstItem.querySelector("[data-cart-category] .text-block-wrap-div");
        if (categoryEl) categoryEl.textContent = "Раздел";
        const heightEl = popupCache.firstItem.querySelector("[data-cart-height] .text-block-wrap-div");
        if (heightEl) heightEl.textContent = "Размер";
        const sumEl = popupCache.firstItem.querySelector("[data-cart-sum] .text-block-wrap-div");
        if (sumEl) sumEl.textContent = "Цена";
        const qtyEl = popupCache.firstItem.querySelector(".count-summ-wrapper .text .text-block-wrap-div, .count-wrapper-2 .text .text-block-wrap-div");
        if (qtyEl) qtyEl.textContent = "1 шт.";
      }
      popupCache.firstItem = null;
      totalSumCache = null;
      totalOfferCache = null;
      itemElementsCache = /* @__PURE__ */ new WeakMap();
      if (popup) {
        popup.style.display = "none";
        popup.style.visibility = "hidden";
        popup.style.opacity = "0";
        popup.setAttribute("hidden", "");
        popup.setAttribute("aria-hidden", "true");
        popup.classList.add("hidden", "closed");
        popup.classList.remove("open", "active", "show");
        restoreScroll();
        setTimeout(restoreScroll, 10);
        setTimeout(restoreScroll, 50);
        setTimeout(restoreScroll, 100);
        const closeBtn = popup.querySelector('[data-cart-close], .close-btn, [aria-label*="закрыть" i], [aria-label*="close" i]');
        if (closeBtn) {
          try {
            closeBtn.click();
          } catch (e) {
            try {
              const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
              closeBtn.dispatchEvent(clickEvent);
            } catch (e2) {
            }
          }
        }
      }
    }
  }
  function updateCartItemQty(itemId, newQty) {
    const cart = getCart();
    const item = cart.find((it) => getItemId(it) === itemId);
    if (item) {
      if (newQty <= 0) {
        removeFromCart(itemId);
      } else {
        item.qty = Math.max(1, Math.floor(newQty));
        setCart(cart);
      }
    }
  }
  var popupCache = {
    firstItem: null,
    bagWrapper: null,
    divider: null
  };
  function initImageLightbox() {
    if (window.__ladyElkaImageLightboxInit) return;
    window.__ladyElkaImageLightboxInit = true;
    const isTreePage = /^\/tree(?:\/|$)/.test(window.location.pathname);
    const denyAttr = "data-nozoom";
    const galleryRootSelector = [
      "[data-gallery]",
      "[data-product-gallery]",
      "[data-tt-collection-item-id]",
      ".product-card",
      ".product-wrapper__cms",
      ".collection__item"
    ].join(",");
    const photoWrapSelector = [
      ".product__img",
      ".product__img__cms",
      ".product__img-dop",
      ".product__img-dop__cms",
      "[data-gallery-photo]",
      "[data-zoom-photo]"
    ].join(",");
    const style = document.createElement("style");
    style.id = "lady-elka-image-lightbox-styles";
    style.textContent = `
    #img-zoom-overlay{
      position:fixed; inset:0; display:none;
      align-items:center; justify-content:center;
      background:rgba(0,0,0,.9); z-index:2147483647;
    }
    #img-zoom-overlay.izo-open{
      display:flex; animation:izo-fade .12s ease-out;
    }
    @keyframes izo-fade{ from{opacity:0} to{opacity:1} }
    #img-zoom-overlay .izo-holder{
      max-width:96vw; max-height:96vh;
      display:flex; align-items:center; justify-content:center;
    }
    #img-zoom-overlay .izo-media,
    #img-zoom-overlay .izo-media img{
      display:block !important;
      max-width:96vw; max-height:96vh;
      box-shadow:0 10px 40px rgba(0,0,0,.6);
      border-radius:8px; object-fit:contain;
      user-select:none; -webkit-user-drag:none;
    }
    #img-zoom-overlay .izo-close,
    #img-zoom-overlay .izo-arrow{
      position:fixed; display:flex; align-items:center;
      justify-content:center; padding:0; border:0; color:#fff;
      background:rgba(255,255,255,.12); cursor:pointer; z-index:2;
    }
    #img-zoom-overlay .izo-close{
      top:16px; right:16px; width:40px; height:40px;
      border-radius:10px; font:700 24px/1 ui-sans-serif,system-ui,Arial;
    }
    #img-zoom-overlay .izo-arrow{
      top:50%; width:44px; height:44px; margin-top:-22px;
      border:1px solid rgba(255,255,255,.28);
      border-radius:50%; font-size:0; line-height:0;
      background:rgba(0,0,0,.42);
      box-shadow:0 4px 16px rgba(0,0,0,.3);
    }
    #img-zoom-overlay .izo-arrow::before{
      content:''; display:block; width:9px; height:9px;
      border:solid #fff; border-width:0 2px 2px 0;
    }
    #img-zoom-overlay .izo-prev::before{ transform:rotate(135deg); margin-left:4px; }
    #img-zoom-overlay .izo-next::before{ transform:rotate(-45deg); margin-right:4px; }
    #img-zoom-overlay .izo-prev{ left:24px; }
    #img-zoom-overlay .izo-next{ right:24px; }
    #img-zoom-overlay .izo-close:hover,
    #img-zoom-overlay .izo-arrow:hover{ background:rgba(255,255,255,.24); }
    #img-zoom-overlay .izo-close:focus,
    #img-zoom-overlay .izo-arrow:focus{
      outline:2px solid rgba(255,255,255,.65); outline-offset:3px;
    }
    #img-zoom-overlay [hidden]{ display:none !important; }
    img.can-zoom{ cursor:zoom-in; }
    @media (max-width:600px){
      #img-zoom-overlay .izo-arrow{
        width:38px; height:38px; margin-top:-19px;
      }
      #img-zoom-overlay .izo-prev{ left:8px; }
      #img-zoom-overlay .izo-next{ right:8px; }
    }
  `;
    const overlay = document.createElement("div");
    overlay.id = "img-zoom-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.tabIndex = -1;
    const holder = document.createElement("div");
    holder.className = "izo-holder";
    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "izo-arrow izo-prev";
    prevBtn.setAttribute("aria-label", "Предыдущее фото");
    prevBtn.innerHTML = "&#10094;";
    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "izo-arrow izo-next";
    nextBtn.setAttribute("aria-label", "Следующее фото");
    nextBtn.innerHTML = "&#10095;";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "izo-close";
    closeBtn.setAttribute("aria-label", "Закрыть");
    closeBtn.textContent = "×";
    overlay.append(holder, prevBtn, nextBtn, closeBtn);
    function mount() {
      if (!document.head.querySelector("#lady-elka-image-lightbox-styles")) {
        document.head.appendChild(style);
      }
      if (document.body && !document.body.contains(overlay)) {
        document.body.appendChild(overlay);
      }
    }
    function getPhotoUrl(img) {
      return img.getAttribute("data-origin-src") || img.currentSrc || img.getAttribute("src") || "";
    }
    function isPlaceholderImage(img) {
      const marker = [
        getPhotoUrl(img),
        img.getAttribute("src"),
        img.getAttribute("data-origin-src"),
        img.getAttribute("data-src"),
        img.getAttribute("alt"),
        img.className
      ].filter(Boolean).join(" ").toLowerCase();
      return /placeholder|no[-_ ]?image|no[-_ ]?photo|empty[-_ ]?image|default[-_ ]?image/.test(marker);
    }
    function isAllowedImage(img) {
      if (!img || img.nodeName !== "IMG") return false;
      if (img.hasAttribute(denyAttr) || img.closest("[" + denyAttr + "]")) return false;
      if (!getPhotoUrl(img)) return false;
      if (isPlaceholderImage(img)) return false;
      if (!img.matches('[data-zoom="on"]') && img.closest("a[href]")) return false;
      return true;
    }
    function isZoomable(img) {
      if (!isAllowedImage(img)) return false;
      const box = img.getBoundingClientRect();
      return box.width >= 48 && box.height >= 48;
    }
    function markZoomables(root) {
      if (!root) return;
      const images = [];
      if (root.nodeName === "IMG") images.push(root);
      if (root.querySelectorAll) images.push(...root.querySelectorAll("img"));
      images.forEach((img) => {
        if (isZoomable(img)) img.classList.add("can-zoom");
        else img.classList.remove("can-zoom");
      });
    }
    function getGalleryRoot(img) {
      return img.closest(galleryRootSelector) || img.parentElement || document;
    }
    function getGalleryImages(clickedImg) {
      const root = getGalleryRoot(clickedImg);
      const candidates = Array.from(root.querySelectorAll("img"));
      if (!candidates.includes(clickedImg)) candidates.push(clickedImg);
      const result = [];
      const seenUrls = /* @__PURE__ */ new Set();
      candidates.forEach((img) => {
        if (!isAllowedImage(img)) return;
        const inPhotoWrapper = img.closest(photoWrapSelector);
        const explicitGallery = root.matches && root.matches(
          "[data-gallery], [data-product-gallery]"
        );
        const box = img.getBoundingClientRect();
        const largeVisibleImage = box.width >= 48 && box.height >= 48;
        if (img !== clickedImg && !inPhotoWrapper && !explicitGallery && !largeVisibleImage) return;
        const url = getPhotoUrl(img);
        if (!url || seenUrls.has(url)) return;
        seenUrls.add(url);
        result.push(img);
      });
      return result.length ? result : [clickedImg];
    }
    let opened = false;
    let gallery = [];
    let galleryIndex = 0;
    let previousOverflow = "";
    function renderSlide() {
      const img = gallery[galleryIndex];
      if (!img) return;
      holder.innerHTML = "";
      const picture = img.closest("picture");
      let node;
      if (picture) {
        node = picture.cloneNode(true);
        node.classList.add("izo-media");
        node.removeAttribute("hidden");
        node.style.removeProperty("display");
        node.style.removeProperty("visibility");
        node.style.removeProperty("opacity");
        const clonedImg = node.querySelector("img");
        if (clonedImg) {
          clonedImg.classList.add("izo-media");
          clonedImg.removeAttribute("hidden");
          clonedImg.style.removeProperty("display");
          clonedImg.style.removeProperty("visibility");
          clonedImg.style.removeProperty("opacity");
          clonedImg.decoding = "sync";
          clonedImg.loading = "eager";
          const url = getPhotoUrl(img);
          if (url) clonedImg.src = url;
        }
      } else {
        node = img.cloneNode(true);
        node.classList.add("izo-media");
        node.removeAttribute("hidden");
        node.style.removeProperty("display");
        node.style.removeProperty("visibility");
        node.style.removeProperty("opacity");
        node.decoding = "sync";
        node.loading = "eager";
        const url = getPhotoUrl(img);
        if (url) node.src = url;
      }
      holder.appendChild(node);
      const hasGallery = isTreePage && gallery.length > 1;
      prevBtn.hidden = !hasGallery;
      nextBtn.hidden = !hasGallery;
    }
    function openZoomFrom(img) {
      mount();
      gallery = isTreePage ? getGalleryImages(img) : [img];
      galleryIndex = Math.max(0, gallery.indexOf(img));
      renderSlide();
      previousOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";
      overlay.classList.add("izo-open");
      opened = true;
      setTimeout(() => overlay.focus(), 0);
    }
    function showSlide(step) {
      if (!opened || gallery.length < 2) return;
      galleryIndex = (galleryIndex + step + gallery.length) % gallery.length;
      renderSlide();
    }
    function closeZoom() {
      if (!opened) return;
      overlay.classList.remove("izo-open");
      document.documentElement.style.overflow = previousOverflow;
      holder.innerHTML = "";
      gallery = [];
      galleryIndex = 0;
      opened = false;
    }
    document.addEventListener("click", (e) => {
      const img = e.target.closest && e.target.closest("img");
      if (!img || overlay.contains(img) || !isZoomable(img)) return;
      e.preventDefault();
      e.stopPropagation();
      openZoomFrom(img);
    }, true);
    prevBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showSlide(-1);
    });
    nextBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showSlide(1);
    });
    closeBtn.addEventListener("click", closeZoom);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeZoom();
    });
    document.addEventListener("keydown", (e) => {
      if (!opened) return;
      if (e.key === "Escape") closeZoom();
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        showSlide(-1);
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        showSlide(1);
      }
    });
    const init = () => {
      mount();
      markZoomables(document);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
      init();
    }
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === "childList") {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === 1) markZoomables(node);
          });
        }
        if (mutation.type === "attributes" && mutation.target.nodeName === "IMG") {
          markZoomables(mutation.target);
        }
      });
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "src",
        "srcset",
        "data-origin-src",
        "data-nozoom",
        "style"
      ]
    });
  }
  initImageLightbox();
  function fillPopup() {
    if (!popup) return;
    const cart = getCart();
    if (!popupCache.firstItem) {
      popupCache.firstItem = popup.querySelector(".item-wrapper__shop:not([data-bag-wrapper]):not([data-cart-item])");
    }
    if (!popupCache.firstItem) {
      const anyItem = popup.querySelector(".item-wrapper__shop:not([data-bag-wrapper])");
      if (anyItem) {
        anyItem.removeAttribute("data-cart-item");
        popupCache.firstItem = anyItem;
      }
    }
    if (!popupCache.firstItem) return;
    if (popupCache.firstItem.hasAttribute("data-cart-item")) {
      const oldItemId = popupCache.firstItem.getAttribute("data-cart-item");
      const currentItemId = cart.length > 0 ? getItemId(cart[0]) : null;
      if (oldItemId !== currentItemId) {
        popupCache.firstItem.removeAttribute("data-cart-item");
      }
    }
    if (!popupCache.bagWrapper) {
      popupCache.bagWrapper = popup.querySelector("[data-bag-wrapper]");
    }
    if (!popupCache.divider) {
      popupCache.divider = popup.querySelector(".divider");
    }
    const insertBefore = popupCache.bagWrapper || popupCache.divider;
    const allItems = Array.from(popup.querySelectorAll(".item-wrapper__shop[data-cart-item]"));
    allItems.forEach((el) => {
      if (el !== popupCache.firstItem) {
        el.remove();
      }
    });
    if (!cart.length) {
      if (popupCache.firstItem && popupCache.firstItem.hasAttribute("data-cart-item")) {
        popupCache.firstItem.removeAttribute("data-cart-item");
      }
      if (popupCache.firstItem) {
        popupCache.firstItem.style.display = "none";
      }
      updateCartTotal();
      return;
    }
    cart.forEach((item, i) => {
      const itemId = getItemId(item);
      let itemEl;
      if (i === 0) {
        itemEl = popupCache.firstItem;
        if (itemEl.hasAttribute("data-cart-item")) {
          const oldItemId = itemEl.getAttribute("data-cart-item");
          if (oldItemId !== itemId) {
            itemElementsCache.delete(itemEl);
          }
        }
        itemEl.setAttribute("data-cart-item", itemId);
        itemEl.style.display = "";
        itemEl.style.visibility = "";
        itemEl.style.opacity = "";
        itemEl.removeAttribute("hidden");
        itemEl.classList.remove("hidden");
      } else {
        itemEl = popupCache.firstItem.cloneNode(true);
        itemEl.setAttribute("data-cart-item", itemId);
        itemEl.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
        if (insertBefore && insertBefore.parentElement) {
          insertBefore.parentElement.insertBefore(itemEl, insertBefore);
        } else if (popupCache.firstItem.parentElement) {
          popupCache.firstItem.parentElement.insertBefore(itemEl, popupCache.firstItem.nextSibling);
        }
      }
      if (itemEl) {
        updateCartItemDisplay(itemEl, item, itemId);
      }
    });
    if (!popupCache.firstItem.hasAttribute("data-cart-item")) {
      popupCache.firstItem.style.display = "none";
    }
    updateCartTotal();
  }
  var itemElementsCache = /* @__PURE__ */ new WeakMap();
  function updateCartItemDisplay(itemEl, item, itemId) {
    if (!itemEl || !item) return;
    const currentItemId = itemEl.getAttribute("data-cart-item");
    if (currentItemId && currentItemId !== itemId) {
      itemElementsCache.delete(itemEl);
    }
    let cached = itemElementsCache.get(itemEl);
    if (!cached) {
      cached = {
        ph: itemEl.querySelector("[data-cart-photo]"),
        img: null,
        tEl: itemEl.querySelector("[data-cart-title]"),
        hEl: itemEl.querySelector("[data-cart-height]"),
        cEl: itemEl.querySelector("[data-cart-category]"),
        qtyEl: itemEl.querySelector(".count-summ-wrapper .text, .count-wrapper-2 .text"),
        sEl: itemEl.querySelector("[data-cart-sum]"),
        minusBtn: itemEl.querySelector("[data-icons-down]"),
        plusBtn: itemEl.querySelector("[data-icons-up]"),
        removeBtn: itemEl.querySelector("[data-icons-remove]")
      };
      if (cached.ph) {
        cached.img = cached.ph.querySelector("img");
      }
      if (cached.sEl) {
        cached.sElSpan = cached.sEl.querySelector(".text-block-wrap-div") || cached.sEl;
      }
      if (cached.qtyEl) {
        cached.qtyElSpan = cached.qtyEl.querySelector(".text-block-wrap-div") || cached.qtyEl;
      }
      itemElementsCache.set(itemEl, cached);
    }
    if (cached.ph) {
      if (cached.img && item.photo) {
        cached.img.src = item.photo;
        cached.img.setAttribute("data-origin-src", item.photo);
        cached.img.alt = item.name;
        cached.img.classList.add("can-zoom");
      } else if (item.photo && !cached.img) {
        cached.ph.style.backgroundImage = `url(${item.photo})`;
        cached.ph.setAttribute("aria-label", item.name);
      }
    }
    if (cached.tEl) {
      const tSpan = cached.tEl.querySelector(".text-block-wrap-div") || cached.tEl;
      setText(tSpan, item.name);
    }
    if (cached.cEl) {
      const cSpan = cached.cEl.querySelector(".text-block-wrap-div") || cached.cEl;
      const catText = String(item.category || "").trim();
      const hideCat = !catText || catText.toLowerCase() === "туя";
      setText(cSpan, hideCat ? "" : catText);
      cached.cEl.style.display = hideCat ? "none" : "";
    }
    const isDecor = String(item.category || "").trim() === "Декор";
    if (cached.hEl) {
      const hSpan = cached.hEl.querySelector(".text-block-wrap-div") || cached.hEl;
      const hText = item.height ? isDecor ? item.height : `${item.height} см` : "";
      setText(hSpan, hText);
      if (isDecor) {
        if (item.height && String(item.height).trim() !== "") {
          cached.hEl.style.display = "";
          const hWrapper = cached.hEl.closest(".input__catalog, .height-wrapper, [data-cart-height-wrapper]");
          if (hWrapper) hWrapper.style.display = "";
        } else {
          cached.hEl.style.display = "none";
          const hWrapper = cached.hEl.closest(".input__catalog, .height-wrapper, [data-cart-height-wrapper]");
          if (hWrapper) hWrapper.style.display = "none";
        }
      } else {
        cached.hEl.style.display = "";
        const hWrapper = cached.hEl.closest(".input__catalog, .height-wrapper, [data-cart-height-wrapper]");
        if (hWrapper) hWrapper.style.display = "";
      }
    }
    const qty = item.qty || 1;
    if (cached.qtyElSpan) {
      const qtyText = `${qty} шт.`;
      setText(cached.qtyElSpan, qtyText);
    }
    const pricePerUnit = item.price || 0;
    if (cached.sElSpan) {
      const priceText = rub(pricePerUnit);
      setText(cached.sElSpan, priceText);
    }
  }
  var totalSumCache = null;
  var totalOfferCache = null;
  function updateCartTotal() {
    const cart = getCart();
    const baseTotal = cart.reduce((sum, item) => sum + (item.price || 0) * (item.qty || 1), 0);
    let promoState = null;
    try {
      promoState = JSON.parse(localStorage.getItem("lady_promo_state") || "null");
    } catch (e) {
    }
    const onlyDecor = cart.length > 0 && cart.every((item) => {
      const category = String(item.category || "").trim();
      return category === "Декор";
    });
    let finalTotal = baseTotal;
    let discountText = "";
    if (!onlyDecor && promoState && (promoState.rub > 0 || promoState.pct > 0)) {
      if (promoState.rub > 0) {
        finalTotal = Math.max(0, baseTotal - promoState.rub);
        discountText = "-" + rub(promoState.rub);
      } else if (promoState.pct > 0) {
        finalTotal = Math.max(0, Math.round(baseTotal * (1 - promoState.pct / 100)));
        discountText = "-" + promoState.pct + "%";
      }
    } else if (onlyDecor && promoState) {
      try {
        localStorage.removeItem("lady_promo_state");
        const promoInput = document.querySelector("[data-promo-input]");
        if (promoInput) promoInput.value = "";
        if (typeof window.LE_Promo !== "undefined" && window.LE_Promo.render) {
          window.LE_Promo.render();
        }
      } catch (e) {
      }
    }
    if (!totalSumCache || !totalOfferCache) {
      const itogoWrapper = popup == null ? void 0 : popup.querySelector(".itogo-wrapper");
      if (itogoWrapper) {
        const totalEl = itogoWrapper.querySelector('[data-cart-title=""]');
        if (totalEl && totalEl.textContent.trim().includes("Итого:")) {
          let sumEl = totalEl.nextElementSibling;
          if (sumEl && sumEl.hasAttribute("data-cart-sum-offer")) {
            sumEl = null;
          }
          if (!sumEl || !sumEl.hasAttribute("data-cart-sum")) {
            sumEl = itogoWrapper.querySelector("[data-cart-sum]:not([data-cart-item]):not([data-cart-sum-offer])");
          }
          if (!sumEl) {
            sumEl = document.createElement("div");
            sumEl.className = "text site-catalog__h1 color__h2";
            sumEl.setAttribute("data-cart-sum", "");
            const span = document.createElement("span");
            span.className = "text-block-wrap-div";
            sumEl.appendChild(span);
            const offerEl = itogoWrapper.querySelector("[data-cart-sum-offer]");
            if (offerEl) {
              itogoWrapper.insertBefore(sumEl, offerEl);
            } else {
              itogoWrapper.insertBefore(sumEl, totalEl.nextSibling);
            }
          }
          totalSumCache = sumEl.querySelector(".text-block-wrap-div") || sumEl;
          totalOfferCache = itogoWrapper.querySelector("[data-cart-sum-offer]");
          if (totalOfferCache) {
            totalOfferCache = totalOfferCache.querySelector(".text-block-wrap-div") || totalOfferCache;
          }
        }
      }
    }
    if (totalSumCache) {
      const priceText = rub(finalTotal);
      if (totalSumCache.textContent !== priceText) {
        setText(totalSumCache, priceText);
      }
    }
    if (totalOfferCache) {
      const offerEl = totalOfferCache.closest("[data-cart-sum-offer]") || totalOfferCache.parentElement;
      if (discountText) {
        const currentText = totalOfferCache.textContent.trim();
        if (currentText !== discountText) {
          setText(totalOfferCache, discountText);
        }
        if (offerEl && offerEl.style) offerEl.style.display = "";
      } else {
        if (offerEl && offerEl.style) offerEl.style.display = "none";
        setText(totalOfferCache, "");
      }
    }
  }
  document.addEventListener("click", (e) => {
    var _a, _b, _c;
    let minus = e.target.closest(`[data-icons-down]`);
    if (!minus && e.target.tagName === "IMG") {
      minus = e.target.closest(`[data-icons-down]`) || ((_a = e.target.parentElement) == null ? void 0 : _a.closest(`[data-icons-down]`));
    }
    if (minus) {
      e.preventDefault();
      e.stopPropagation();
      const itemEl = minus.closest(".item-wrapper__shop[data-cart-item]");
      if (!itemEl) {
        console.warn("Не найден элемент товара для кнопки минус");
        return;
      }
      const itemId = itemEl.getAttribute("data-cart-item");
      if (!itemId) {
        console.warn("Не найден itemId для кнопки минус");
        return;
      }
      const cart = getCart();
      const item = cart.find((it) => getItemId(it) === itemId);
      if (item) {
        const newQty = (item.qty || 1) - 1;
        const willBeEmpty = cart.length === 1 && newQty <= 0;
        updateCartItemQty(itemId, newQty);
        requestAnimationFrame(() => {
          const cartAfter = getCart();
          if (cartAfter.length === 0) {
            if (popup) {
              popup.style.display = "none";
              popup.setAttribute("hidden", "");
            }
          } else {
            itemElementsCache = /* @__PURE__ */ new WeakMap();
            fillPopup();
          }
        });
      }
      return;
    }
    let plus = e.target.closest(`[data-icons-up]`);
    if (!plus && e.target.tagName === "IMG") {
      plus = e.target.closest(`[data-icons-up]`) || ((_b = e.target.parentElement) == null ? void 0 : _b.closest(`[data-icons-up]`));
    }
    if (plus) {
      e.preventDefault();
      e.stopPropagation();
      const itemEl = plus.closest(".item-wrapper__shop[data-cart-item]");
      if (!itemEl) {
        console.warn("Не найден элемент товара для кнопки плюс");
        return;
      }
      const itemId = itemEl.getAttribute("data-cart-item");
      if (!itemId) {
        console.warn("Не найден itemId для кнопки плюс");
        return;
      }
      const cart = getCart();
      const item = cart.find((it) => getItemId(it) === itemId);
      if (item) {
        updateCartItemQty(itemId, (item.qty || 1) + 1);
        requestAnimationFrame(() => {
          itemElementsCache = /* @__PURE__ */ new WeakMap();
          fillPopup();
        });
      }
      return;
    }
    let remove = e.target.closest(`[data-icons-remove]`);
    if (!remove && e.target.tagName === "IMG") {
      remove = e.target.closest(`[data-icons-remove]`) || ((_c = e.target.parentElement) == null ? void 0 : _c.closest(`[data-icons-remove]`));
    }
    if (remove) {
      e.preventDefault();
      e.stopPropagation();
      const itemEl = remove.closest(".item-wrapper__shop[data-cart-item]");
      if (!itemEl) {
        console.warn("Не найден элемент товара для кнопки удаления");
        return;
      }
      const itemId = itemEl.getAttribute("data-cart-item");
      if (!itemId) {
        console.warn("Не найден itemId для кнопки удаления");
        return;
      }
      const cart = getCart();
      const willBeEmpty = cart.length === 1;
      removeFromCart(itemId);
      requestAnimationFrame(() => {
        const cartAfter = getCart();
        if (cartAfter.length === 0) {
          if (popup) {
            popup.style.display = "none";
            popup.style.visibility = "hidden";
            popup.setAttribute("hidden", "");
            popup.classList.add("hidden");
          }
        } else {
          popupCache.lastUpdate = 0;
          itemElementsCache = /* @__PURE__ */ new WeakMap();
          fillPopup();
        }
      });
      return;
    }
  }, true);
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".buy-btn");
    if (!btn) return;
    const name = (btn.dataset.name || "").trim();
    const price = num(btn.dataset.price || 0);
    if (!name || name === "Товар") {
      console.warn('Кнопка "в корзину" не имеет названия:', {
        name: btn.dataset.name,
        price: btn.dataset.price,
        height: btn.dataset.height,
        category: btn.dataset.category
      });
      return;
    }
    const item = {
      name,
      height: btn.dataset.height || "",
      price,
      photo: btn.dataset.photo || "",
      category: btn.dataset.category || "",
      qty: 1
    };
    addToCart(item);
    const cart = getCart();
    if (popup && cart.length > 0) {
      popupCache.firstItem = null;
      if (popupObserver) {
        popupObserver.disconnect();
      }
      syncCartPricesAndRender();
      popup.style.display = "";
      popup.style.visibility = "";
      popup.style.opacity = "";
      popup.removeAttribute("hidden");
      popup.classList.remove("hidden", "closed");
      wasPopupOpen = true;
      setTimeout(() => {
        if (popupObserver && popup) {
          popupObserver.observe(popup, { attributes: true, attributeFilter: ["style", "class", "hidden"] });
        }
      }, 500);
    }
    requestAnimationFrame(() => {
      try {
        const st = JSON.parse(localStorage.getItem("lady_promo_state") || "null");
        if (st && (st.rub > 0 || st.pct > 0 || st.gift)) {
          const cartCheck = getCart();
          if (cartCheck.length) {
            var baseTotal = 0;
            cartCheck.forEach(function(cartItem) {
              if (typeof cartItem.basePrice !== "number") {
                cartItem.basePrice = num(cartItem.price || 0);
              }
              baseTotal += cartItem.basePrice * (cartItem.qty || 1);
            });
            st.baseTotal = baseTotal;
            localStorage.setItem("lady_promo_state", JSON.stringify(st));
          }
        }
      } catch (e2) {
      }
      const cartAfter = getCart();
      if (cartAfter.length > 0 && popup) {
        itemElementsCache = /* @__PURE__ */ new WeakMap();
        fillPopup();
        if (typeof window.LE_Promo !== "undefined" && window.LE_Promo.render) {
          window.LE_Promo.render();
        }
        const checkAndShow = () => {
          const cartCheck = getCart();
          if (cartCheck.length > 0 && popup) {
            const computed = getComputedStyle(popup);
            if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") {
              popup.style.display = "";
              popup.style.visibility = "";
              popup.style.opacity = "";
              popup.removeAttribute("hidden");
              popup.classList.remove("hidden", "closed");
            }
          }
        };
        setTimeout(checkAndShow, 50);
        setTimeout(checkAndShow, 150);
        setTimeout(checkAndShow, 300);
        setTimeout(checkAndShow, 500);
      }
    });
  }, true);
  if (popup) {
    const closeBtn = popup.querySelector('[data-cart-close], .close-btn, [aria-label*="закрыть" i], [aria-label*="close" i], [data-close]');
    if (closeBtn) {
      closeBtn.addEventListener("click", function(e) {
        restoreScroll();
      }, { once: false });
    }
    popup.addEventListener("click", function(e) {
      if (e.target === popup || e.target.classList.contains("pop-up") || e.target.hasAttribute("data-cart-popup")) {
        restoreScroll();
      }
    });
  }
  var fillPopupTimer = null;
  var wasPopupOpen = false;
  var isManuallyOpening = false;
  var popupObserver = popup ? new MutationObserver(() => {
    const isOpen = popup && getComputedStyle(popup).display !== "none";
    if (isOpen) {
      if (!wasPopupOpen) {
        itemElementsCache = /* @__PURE__ */ new WeakMap();
        isManuallyOpening = false;
        syncCartPricesAndRender();
      }
      wasPopupOpen = true;
      clearTimeout(fillPopupTimer);
      fillPopupTimer = setTimeout(() => {
        requestAnimationFrame(() => {
          const cart = getCart();
          if (cart.length > 0) {
            fillPopup();
            updateCartTotal();
          }
        });
      }, 50);
    } else {
      if (wasPopupOpen) {
        restoreScroll();
        setTimeout(restoreScroll, 10);
        setTimeout(restoreScroll, 50);
      }
      wasPopupOpen = false;
    }
  }) : null;
  if (popupObserver && popup) {
    popupObserver.observe(popup, { attributes: true, attributeFilter: ["style", "class", "hidden"] });
  }
  var scrollRestoreInterval = null;
  function startScrollRestoreWatch() {
    if (scrollRestoreInterval) return;
    scrollRestoreInterval = setInterval(() => {
      if (popup) {
        const isOpen = getComputedStyle(popup).display !== "none" && !popup.hasAttribute("hidden") && !popup.classList.contains("hidden");
        if (!isOpen) {
          const bodyOverflow = getComputedStyle(document.body).overflow;
          const htmlOverflow = getComputedStyle(document.documentElement).overflow;
          if (bodyOverflow === "hidden" || htmlOverflow === "hidden") {
            restoreScroll();
          }
        }
      }
    }, 200);
  }
  startScrollRestoreWatch();
  (function() {
    "use strict";
    async function openPayInNewTab2(payload) {
      const endpoint = String(window.PAYMENT_ENDPOINT || "").trim();
      if (!endpoint) {
        alert("Платёжный сервис не настроен");
        return;
      }
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768 && "ontouchstart" in window;
      const payWindow = isMobile ? null : window.open("", "_blank");
      if (payWindow) {
        payWindow.document.title = "Переход к оплате";
        payWindow.document.body.textContent = "Создаём платёж…";
      }
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const result = await response.json().catch(function() {
          return {};
        });
        if (!response.ok || !result.url) {
          throw new Error(result.message || result.errorMessage || result.error || "Не удалось создать платёж");
        }
        if (payWindow && !payWindow.closed) payWindow.location.replace(result.url);
        else window.location.assign(result.url);
      } catch (error) {
        if (payWindow && !payWindow.closed) payWindow.close();
        console.error("Payment creation failed:", error);
        alert(error && error.message ? error.message : "Не удалось создать платёж. Попробуйте ещё раз.");
      }
    }
    window.openPayInNewTab = openPayInNewTab2;
  })();
  window.PAYMENT_ENDPOINT = "https://mgnotvaahftrbifqtahf.supabase.co/functions/v1/pay";
  if (typeof window.openPayInNewTab !== "function") {
    console.warn("openPayInNewTab не найдена в window, проверьте порядок загрузки скриптов");
  }
  (function preconnect() {
    const l = document.createElement("link");
    l.rel = "preconnect";
    l.href = new URL(window.PAYMENT_ENDPOINT).origin;
    l.crossOrigin = "";
    document.head.appendChild(l);
  })();
  (function lockThanksForever() {
    let allowRedirect = false;
    let redirectTimer = null;
    const checkAllowRedirect = () => {
      const params = new URLSearchParams(window.location.search);
      const hasPayKeeperParams = params.has("orderid") || params.has("invoice_id") || params.has("id");
      if (hasPayKeeperParams) {
        allowRedirect = true;
        return true;
      }
      if (redirectTimer) return allowRedirect;
      redirectTimer = setTimeout(() => {
        allowRedirect = true;
      }, 2 * 60 * 1e3);
      return allowRedirect;
    };
    const bad = (href) => {
      if (checkAllowRedirect()) return false;
      try {
        const u = new URL(href, location.href);
        const p = (u.pathname || "").toLowerCase();
        return /(^|\/)(spasibo|thanks)(\/|$)/i.test(p);
      } catch {
        return false;
      }
    };
    const loc = window.location;
    const oA = { assign: loc.assign.bind(loc), replace: loc.replace.bind(loc) };
    loc.assign = (url, ...r) => bad(url) ? void 0 : oA.assign(url, ...r);
    loc.replace = (url, ...r) => bad(url) ? void 0 : oA.replace(url, ...r);
    const oH = { push: history.pushState.bind(history), rpl: history.replaceState.bind(history) };
    history.pushState = (s, t, u) => bad(u) ? void 0 : oH.push(s, t, u);
    history.replaceState = (s, t, u) => bad(u) ? void 0 : oH.rpl(s, t, u);
    document.addEventListener("click", (e) => {
      var _a, _b, _c;
      const a = (_b = (_a = e.target).closest) == null ? void 0 : _b.call(_a, "a[href]");
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (bad(href)) {
        e.preventDefault();
        e.stopPropagation();
        (_c = e.stopImmediatePropagation) == null ? void 0 : _c.call(e);
      }
    }, true);
  })();
  function lockThanksRedirect() {
    const bad = (href) => {
      try {
        return isThankUrl(href);
      } catch {
        return false;
      }
    };
    const loc = window.location;
    const orig = {
      assign: loc.assign.bind(loc),
      replace: loc.replace.bind(loc),
      push: history.pushState.bind(history),
      rpl: history.replaceState.bind(history)
    };
    const guard = (fn) => (url, ...rest) => {
      if (bad(url)) return;
      return fn(url, ...rest);
    };
    loc.assign = guard(orig.assign);
    loc.replace = guard(orig.replace);
    history.pushState = (s, t, u) => bad(u) ? void 0 : orig.push(s, t, u);
    history.replaceState = (s, t, u) => bad(u) ? void 0 : orig.rpl(s, t, u);
    let done = false;
    const unlock = () => {
      if (done) return;
      done = true;
      loc.assign = orig.assign;
      loc.replace = orig.replace;
      history.pushState = orig.push;
      history.replaceState = orig.rpl;
    };
    const onHide = () => {
      if (document.hidden) unlock();
    };
    document.addEventListener("visibilitychange", onHide, { once: true });
    window.addEventListener("blur", onHide, { once: true });
    setTimeout(unlock, 2e4);
    return unlock;
  }
  var warmPayLink = /* @__PURE__ */ (() => {
    let fired = false;
    return () => {
      if (fired) return;
      fired = true;
      fetch(window.PAYMENT_ENDPOINT, { method: "GET", mode: "no-cors", cache: "no-store", keepalive: true }).catch(() => {
      });
    };
  })();
  if (popup) {
    new MutationObserver(() => {
      try {
        const vis = getComputedStyle(popup).display !== "none";
        if (vis) {
          warmPayLink();
          updatePayUI();
          neuterPayAnchors();
          const cart = getCart();
          const form = popup.querySelector("form");
          if (cart.length && form) {
            purgeLegacyHiddenFields(form);
            ensureTapTopCartFields(form, cart);
            ensureOrderHiddenFields(form, cart);
          }
        }
      } catch {
      }
    }).observe(popup, { attributes: true, attributeFilter: ["style", "class"] });
  }
  function validatePopupForm(form) {
    const nameEl = form == null ? void 0 : form.querySelector('input[type="text"], [name="name"], [name="fio"]');
    const mailEl = form == null ? void 0 : form.querySelector('input[type="email"], [name="email"]');
    const phoneEl = form == null ? void 0 : form.querySelector('input[type="tel"],   [name="phone"]');
    const agreeEl = (form == null ? void 0 : form.querySelector('[data-type-field="checkbox_group"][data-agree] input[type="checkbox"]')) || (form == null ? void 0 : form.querySelector('label[data-agree] input[type="checkbox"]')) || (form == null ? void 0 : form.querySelector(
      'input[type="checkbox"][data-agree], input[type="checkbox"][name*="agree" i], input[type="checkbox"][id*="agree" i], input[type="checkbox"][name*="соглас" i], input[type="checkbox"][id*="соглас" i], input[type="checkbox"][name*="privacy" i], input[type="checkbox"][name*="policy" i]'
    ));
    if (agreeEl) {
      agreeEl.required = true;
      agreeEl.removeAttribute("readonly");
      const agreeWrap = agreeEl.closest('[data-type-field="checkbox_group"][data-agree]') || agreeEl.closest(".form__field") || agreeEl.closest("[data-agree]");
      const syncError = () => agreeWrap == null ? void 0 : agreeWrap.classList.toggle("is-error", !agreeEl.checked);
      syncError();
      agreeEl.setCustomValidity(agreeEl.checked ? "" : "Поставьте галочку согласия на обработку данных");
      agreeEl.addEventListener("change", () => {
        agreeEl.setCustomValidity("");
        syncError();
      });
    }
    if (nameEl) {
      nameEl.removeAttribute("required");
      nameEl.removeAttribute("pattern");
    }
    if (mailEl) mailEl.required = true;
    if (phoneEl) {
      phoneEl.required = true;
      phoneEl.removeAttribute("pattern");
      phoneEl.title = "Введите телефон: минимум 10 цифр (можно со скобками и дефисами)";
      const validatePhone = () => {
        const value = phoneEl.value.replace(/[^\d]/g, "");
        const isValid = value.length >= 10;
        phoneEl.setCustomValidity(isValid ? "" : "Введите телефон: минимум 10 цифр");
        return isValid;
      };
      phoneEl.addEventListener("input", validatePhone);
      phoneEl.addEventListener("blur", validatePhone);
    }
    try {
      if ((form == null ? void 0 : form.reportValidity) && !form.reportValidity()) return false;
    } catch (e) {
    }
    const emailOk = !!((mailEl == null ? void 0 : mailEl.value) || "").trim().match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    const phoneOk = ((phoneEl == null ? void 0 : phoneEl.value) || "").replace(/[^\d]/g, "").length >= 10;
    const agreeOk = !!(agreeEl && agreeEl.checked);
    return emailOk && phoneOk && agreeOk;
  }
  function upsertTTTextField(form, label, value, key) {
    let wrap = form.querySelector(`[data-le-key="${key}"]`);
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "form__field input-wrapper__form";
      wrap.setAttribute("data-type-field", "text");
      wrap.setAttribute("data-le-key", key);
      Object.assign(wrap.style, { position: "absolute", left: "-10000px", width: "1px", height: "1px", overflow: "hidden" });
      const input = document.createElement("input");
      input.type = "text";
      input.className = "form__input input__form site__h4 color__h2";
      input.placeholder = label;
      input.name = label;
      input.setAttribute("aria-hidden", "true");
      input.tabIndex = -1;
      wrap.appendChild(input);
      form.appendChild(wrap);
    }
    wrap.querySelector("input").value = String(value != null ? value : "");
  }
  function purgeLegacyHiddenFields(form) {
    const legacyNames = [
      "order_title",
      "order_amount",
      "title",
      "sum",
      "amount",
      "product_name",
      "product_category",
      "product_height_cm",
      "product_price",
      "promo_code"
    ];
    legacyNames.forEach((n) => {
      form.querySelectorAll(`input[name="${n}"]`).forEach((el) => el.remove());
    });
    form.querySelectorAll("[data-le-key]").forEach((el) => el.remove());
  }
  function ensureTapTopCartFields(form, items) {
    const cart = Array.isArray(items) ? items : items ? [items] : getCart();
    if (!cart.length) return;
    const ensureHidden = (name, val) => {
      let el = form.querySelector(`[name="${name}"]`);
      if (!el) {
        el = document.createElement("input");
        el.type = "hidden";
        el.name = name;
        form.appendChild(el);
      }
      el.value = String(val != null ? val : "");
    };
    const baseTotal = cart.reduce((sum, item) => {
      const price = Number(String(item.price || 0).replace(/[^\d.-]/g, "")) || 0;
      const qty = Number(item.qty || 1);
      return sum + price * qty;
    }, 0);
    let finalTotal = baseTotal;
    try {
      const promoState = JSON.parse(localStorage.getItem("lady_promo_state") || "null");
      if (promoState && promoState.rub > 0) {
        finalTotal = Math.max(0, baseTotal - promoState.rub);
      } else if (promoState && promoState.pct > 0) {
        finalTotal = Math.max(0, Math.round(baseTotal * (1 - promoState.pct / 100)));
      }
    } catch (e) {
    }
    ensureHidden("cart_total", finalTotal);
    let ci = form.querySelector('[name="cart_items"]');
    if (!ci) {
      ci = document.createElement("input");
      ci.type = "hidden";
      ci.name = "cart_items";
      form.appendChild(ci);
    }
    ci.value = JSON.stringify(cart.map((item) => ({
      title: item.name || "Товар",
      price: Number(String(item.price || 0).replace(/[^\d.-]/g, "")) || 0,
      qty: Number(item.qty || 1),
      category: item.category || "",
      height_cm: item.height || ""
    })));
  }
  function ensureOrderHiddenFields(form, items) {
    const cart = Array.isArray(items) ? items : items ? [items] : getCart();
    if (!cart.length) return;
    let promoCode = "";
    try {
      const st = JSON.parse(localStorage.getItem("lady_promo_state")) || {};
      promoCode = (st.code || "").trim();
    } catch {
    }
    const haveReal = haveBuilderFields(form);
    const ensureHidden = (name, val) => {
      let el = form.querySelector(`[name="${name}"]`);
      if (!el) {
        el = document.createElement("input");
        el.type = "hidden";
        el.name = name;
        form.appendChild(el);
      }
      el.value = String(val != null ? val : "");
    };
    const firstItem = cart[0];
    const itemsList = cart.map((item) => {
      const price = Number(String(item.price || 0).replace(/[^\d.-]/g, "")) || 0;
      const qty = Number(item.qty || 1);
      const itemTotal = price * qty;
      return `${item.name || "Товар"}${item.height ? ` ${item.height} см` : ""}${item.category ? ` (${item.category})` : ""}${qty > 1 ? ` x${qty}` : ""} ${itemTotal} ₽`;
    }).join("; ");
    const baseTotal = cart.reduce((sum, item) => sum + (item.price || 0) * (item.qty || 1), 0);
    let totalPrice = baseTotal;
    try {
      const promoState = JSON.parse(localStorage.getItem("lady_promo_state") || "null");
      if (promoState && promoState.rub > 0) {
        totalPrice = Math.max(0, baseTotal - promoState.rub);
      } else if (promoState && promoState.pct > 0) {
        totalPrice = Math.max(0, Math.round(baseTotal * (1 - promoState.pct / 100)));
      }
    } catch (e) {
    }
    ensureHidden("order_title", itemsList || firstItem.name || "");
    ensureHidden("order_price_discounted", String(totalPrice || 0));
    if (haveReal) {
      if (cart.length > 1) {
        fillBuilderFieldsMultiple(form, cart);
      } else {
        fillBuilderFields(form, firstItem);
      }
    } else {
      const itemsListDetailed = cart.map((item) => {
        const price = Number(String(item.price || 0).replace(/[^\d.-]/g, "")) || 0;
        const qty = Number(item.qty || 1);
        const itemTotal = price * qty;
        const parts = [item.name || "Товар"];
        if (item.height) parts.push(`${item.height} см`);
        if (item.category) parts.push(`(${item.category})`);
        if (qty > 1) parts.push(`x${qty}`);
        parts.push(`${itemTotal} ₽`);
        return parts.join(" ");
      }).join("; ");
      upsertTTTextField(form, "Товар", itemsListDetailed || firstItem.name || "", "le-item-name");
      upsertTTTextField(form, "Общая сумма", String(totalPrice || 0), "le-item-price-discounted");
    }
  }
  function platformSubmit(form) {
    if (!(form instanceof HTMLFormElement)) return;
    const hasAction = form.getAttribute("action") && form.getAttribute("action") !== "#";
    if (hasAction) {
      let fr = document.getElementById("le-silent-frame");
      if (!fr) {
        fr = document.createElement("iframe");
        fr.id = "le-silent-frame";
        fr.name = "le-silent-frame";
        Object.assign(fr.style, {
          position: "fixed",
          left: "-9999px",
          top: "-9999px",
          width: "1px",
          height: "1px",
          opacity: "0",
          border: "0"
        });
        document.body.appendChild(fr);
      }
      const prevTarget = form.getAttribute("target");
      form.setAttribute("target", "le-silent-frame");
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        const tmp = document.createElement("button");
        tmp.type = "submit";
        tmp.style.display = "none";
        form.appendChild(tmp);
        tmp.click();
        tmp.remove();
      }
      setTimeout(() => {
        if (prevTarget != null) form.setAttribute("target", prevTarget);
        else form.removeAttribute("target");
      }, 0);
    }
  }
  function findPaySelects() {
    return Array.from((popup == null ? void 0 : popup.querySelectorAll("select")) || []).filter((s) => {
      return Array.from(s.options || []).some((o) => /оплата/i.test(o.textContent || ""));
    });
  }
  function getPayMode() {
    var _a, _b;
    const s = findPaySelects()[0];
    const val = (((_b = (_a = s == null ? void 0 : s.selectedOptions) == null ? void 0 : _a[0]) == null ? void 0 : _b.textContent) || "").toLowerCase();
    return /при\s*получении/.test(val) ? "cod" : "card";
  }
  function updatePayUI() {
    const btn = popup == null ? void 0 : popup.querySelector("[data-pay-now]");
    if (!btn) return;
    const mode = getPayMode();
    btn.dataset.payMode = mode;
    const span = btn.querySelector(".text-block-wrap-div");
    if (span) {
      if (!btn.__origTxt) btn.__origTxt = (span.textContent || "").trim() || "купить";
      span.textContent = mode === "cod" ? "Оформить заказ" : btn.__origTxt;
    }
  }
  document.addEventListener("change", (e) => {
    if (e.target.closest && e.target.closest("select")) updatePayUI();
  }, true);
  try {
    updatePayUI();
  } catch {
  }
  document.addEventListener("click", async (ev) => {
    var _a, _b, _c, _d, _e;
    const payBtn = ev.target.closest("[data-pay-now]");
    if (!payBtn || !payBtn.closest("[data-cart-popup]")) return;
    if (payBtn.hasAttribute("disabled") || payBtn.hasAttribute("data-busy")) return;
    const form = payBtn.closest("form");
    const mode = getPayMode();
    if (!validatePopupForm(form)) {
      (_a = form == null ? void 0 : form.reportValidity) == null ? void 0 : _a.call(form);
      return;
    }
    const cart = getCart();
    if (!cart.length) {
      alert("Корзина пуста");
      return;
    }
    {
      const priceCheck = revalidateCartPrices(cart);
      if (priceCheck.changed) {
        itemElementsCache = /* @__PURE__ */ new WeakMap();
        fillPopup();
        if (typeof window.LE_Promo !== "undefined" && window.LE_Promo.render) window.LE_Promo.render();
        if (priceCheck.raised) {
          alert("Цена на товар в корзине изменилась. Проверьте, пожалуйста, сумму и нажмите оплату ещё раз.");
          return;
        }
      }
    }
    if (mode === "cod") {
      try {
        if (form) {
          fillPopup();
          purgeLegacyHiddenFields(form);
          ensureTapTopCartFields(form, cart);
          ensureOrderHiddenFields(form, cart);
        }
        const unlock2 = lockThanksRedirect();
        unlock2();
        const submitHandler = (submitEv) => {
          ensureTapTopCartFields(form, cart);
          ensureOrderHiddenFields(form, cart);
        };
        form.addEventListener("submit", submitHandler, { once: true });
        return;
      } catch (e) {
        console.error("Error submitting form:", e);
        alert("Ошибка при отправке заказа. Попробуйте еще раз.");
        return;
      }
    }
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
    if (form) {
      fillPopup();
      purgeLegacyHiddenFields(form);
      ensureTapTopCartFields(form, cart);
      ensureOrderHiddenFields(form, cart);
    }
    let promoCode = "";
    try {
      const st = JSON.parse(localStorage.getItem("lady_promo_state")) || {};
      promoCode = (st.code || "").trim();
    } catch {
    }
    payBtn.setAttribute("disabled", "");
    payBtn.setAttribute("data-busy", "1");
    const txtEl = payBtn.querySelector(".text-block-wrap-div");
    const oldTxt = txtEl == null ? void 0 : txtEl.textContent;
    if (txtEl) txtEl.textContent = "Создаю ссылку…";
    const name = ((_b = form == null ? void 0 : form.querySelector('input[type="text"], [name="name"], [name="fio"]')) == null ? void 0 : _b.value) || "";
    const email = ((_c = form == null ? void 0 : form.querySelector('input[type="email"], [name="email"]')) == null ? void 0 : _c.value) || "";
    const phone = ((_d = form == null ? void 0 : form.querySelector('input[type="tel"],   [name="phone"]')) == null ? void 0 : _d.value) || "";
    const address = ((_e = form == null ? void 0 : form.querySelector('input[placeholder*="Адрес"], input[placeholder*="адрес"]')) == null ? void 0 : _e.value) || "";
    const allSelects = (form == null ? void 0 : form.querySelectorAll("select")) || [];
    let contactPref = "";
    for (const select of allSelects) {
      const options = Array.from(select.options || []);
      const hasContactOptions = options.some(
        (opt) => /telegram|whatsapp|позвонить/i.test(opt.textContent || opt.value || "")
      );
      if (hasContactOptions) {
        const selectedOption = options.find((opt) => opt.selected);
        if (selectedOption) {
          contactPref = selectedOption.textContent || selectedOption.value || "";
          break;
        }
      }
    }
    const unlock = lockThanksRedirect();
    try {
      fillPopup();
      purgeLegacyHiddenFields(form);
      ensureTapTopCartFields(form, cart);
      ensureOrderHiddenFields(form, cart);
      const firstItem = cart[0];
      const oid = `LE-${Date.now()}-${(firstItem == null ? void 0 : firstItem.height) || ""}`;
      const itemsList = cart.map((item) => {
        const price = Number(String(item.price || 0).replace(/[^\d.-]/g, "")) || 0;
        const qty = Number(item.qty || 1);
        const itemTotal = price * qty;
        return `${item.name || "Товар"}${item.height ? ` ${item.height} см` : ""}${item.category ? ` (${item.category})` : ""}${qty > 1 ? ` x${qty}` : ""} — ${itemTotal} ₽`;
      }).join(" | ");
      let descr = itemsList;
      if (name) descr += ` | Покупатель: ${name}`;
      if (email) descr += ` | Почта: ${email}`;
      if (phone) descr += ` | Телефон: ${phone}`;
      if (address) descr += ` | Адрес: ${address}`;
      if (contactPref) descr += ` | Связь: ${contactPref}`;
      if (promoCode) descr += ` | Промо: ${promoCode}`;
      descr = descr.trim();
      if (!cart.length) {
        unlock();
        alert("Корзина пуста");
        return;
      }
      const baseAmount = cart.reduce((sum, item) => {
        const price = Number(String(item.price || 0).replace(/[^\d.-]/g, "")) || 0;
        const qty = Number(item.qty || 1);
        return sum + price * qty;
      }, 0);
      let totalAmount = baseAmount;
      let promoDiscountLabel = "";
      let promoGiftLabel = "";
      try {
        const promoState = JSON.parse(localStorage.getItem("lady_promo_state") || "null");
        if (promoState && promoState.rub > 0) {
          totalAmount = Math.max(0, baseAmount - promoState.rub);
          promoDiscountLabel = `${promoState.rub} ₽`;
        } else if (promoState && promoState.pct > 0) {
          totalAmount = Math.max(0, Math.round(baseAmount * (1 - promoState.pct / 100)));
          promoDiscountLabel = `${promoState.pct}% (${Math.max(0, baseAmount - totalAmount)} ₽)`;
        }
        if (promoState && promoState.gift) promoGiftLabel = promoState.giftText || "да";
      } catch (e) {
      }
      if (promoDiscountLabel) descr += ` | Скидка по промокоду: ${promoDiscountLabel}`;
      if (promoGiftLabel) descr += ` | Подарок по промокоду: ${promoGiftLabel}`;
      const payload = {
        amount: totalAmount,
        description: descr,
        email,
        phone,
        orderId: oid,
        clientId: (name || "").trim() || "Леди Елка",
        successUrl: location.origin + `/spasibo?oid=${encodeURIComponent(oid)}`,
        failUrl: location.origin + `/pay-return?fail=1&oid=${encodeURIComponent(oid)}`,
        promoCode: promoCode || "",
        address: address || "",
        contactPref: contactPref || ""
      };
      if (payload.amount <= 0 || !Number.isFinite(payload.amount)) {
        unlock();
        alert("Сумма оплаты нулевая");
        return;
      }
      const payFn = window.openPayInNewTab || openPayInNewTab;
      if (typeof payFn !== "function") {
        unlock();
        alert("Функция оплаты не загружена. Перезагрузите страницу.");
        return;
      }
      payFn(payload);
      platformSubmit(form);
      setTimeout(unlock, 3e3);
    } catch (e) {
      unlock();
      console.error("Pay link error:", e);
      alert("Не удалось создать ссылку на оплату: " + ((e == null ? void 0 : e.message) || "неизвестная ошибка"));
    } finally {
      payBtn.removeAttribute("disabled");
      payBtn.removeAttribute("data-busy");
      if (txtEl && oldTxt) txtEl.textContent = oldTxt;
    }
  }, true);
  ["pointerdown", "mousedown", "mouseup", "pointerup"].forEach((type) => {
    document.addEventListener(type, (ev) => {
      var _a, _b, _c;
      const btn = (_b = (_a = ev.target).closest) == null ? void 0 : _b.call(_a, "[data-pay-now]");
      if (!btn || !btn.closest("[data-cart-popup]")) return;
      if (ev.pointerType === "touch" || ev.type.startsWith("touch")) return;
      const mode = btn.dataset.payMode || getPayMode();
      if (mode === "cod") {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      (_c = ev.stopImmediatePropagation) == null ? void 0 : _c.call(ev);
    }, true);
  });
  var touchStartTime = 0;
  var touchStartTarget = null;
  var touchStartPos = null;
  document.addEventListener("touchstart", (ev) => {
    var _a, _b, _c, _d;
    const payBtn = (_b = (_a = ev.target).closest) == null ? void 0 : _b.call(_a, "[data-pay-now]");
    if (!payBtn || !payBtn.closest("[data-cart-popup]")) return;
    touchStartTime = Date.now();
    touchStartTarget = payBtn;
    touchStartPos = {
      x: ((_c = ev.touches[0]) == null ? void 0 : _c.clientX) || 0,
      y: ((_d = ev.touches[0]) == null ? void 0 : _d.clientY) || 0
    };
  }, true);
  document.addEventListener("touchend", async (ev) => {
    var _a, _b, _c, _d, _e, _f, _g;
    const payBtn = (_b = (_a = ev.target).closest) == null ? void 0 : _b.call(_a, "[data-pay-now]");
    if (!payBtn || !payBtn.closest("[data-cart-popup]")) return;
    if (touchStartTarget !== payBtn) return;
    const touchDuration = Date.now() - touchStartTime;
    if (touchDuration > 300) {
      touchStartTarget = null;
      return;
    }
    if (touchStartPos && ev.changedTouches[0]) {
      const deltaX = Math.abs(ev.changedTouches[0].clientX - touchStartPos.x);
      const deltaY = Math.abs(ev.changedTouches[0].clientY - touchStartPos.y);
      if (deltaX > 10 || deltaY > 10) {
        touchStartTarget = null;
        return;
      }
    }
    const form = payBtn.closest("form");
    if (!form) return;
    if (!validatePopupForm(form)) {
      (_c = form == null ? void 0 : form.reportValidity) == null ? void 0 : _c.call(form);
      touchStartTarget = null;
      return;
    }
    const mode = getPayMode();
    const cart = getCart();
    if (!cart.length) {
      alert("Корзина пуста");
      touchStartTarget = null;
      return;
    }
    {
      const priceCheck = revalidateCartPrices(cart);
      if (priceCheck.changed) {
        itemElementsCache = /* @__PURE__ */ new WeakMap();
        fillPopup();
        if (typeof window.LE_Promo !== "undefined" && window.LE_Promo.render) window.LE_Promo.render();
        if (priceCheck.raised) {
          alert("Цена на товар в корзине изменилась. Проверьте, пожалуйста, сумму и нажмите оплату ещё раз.");
          touchStartTarget = null;
          return;
        }
      }
    }
    if (mode === "cod") {
      try {
        if (form) {
          fillPopup();
          purgeLegacyHiddenFields(form);
          ensureTapTopCartFields(form, cart);
          ensureOrderHiddenFields(form, cart);
        }
        const unlock2 = lockThanksRedirect();
        unlock2();
        const submitHandler = (submitEv) => {
          ensureTapTopCartFields(form, cart);
          ensureOrderHiddenFields(form, cart);
        };
        form.addEventListener("submit", submitHandler, { once: true });
        touchStartTarget = null;
        return;
      } catch (e) {
        console.error("Error submitting form:", e);
        alert("Ошибка при отправке заказа. Попробуйте еще раз.");
        touchStartTarget = null;
        return;
      }
    }
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
    if (form) {
      fillPopup();
      purgeLegacyHiddenFields(form);
      ensureTapTopCartFields(form, cart);
      ensureOrderHiddenFields(form, cart);
    }
    let promoCode = "";
    try {
      const st = JSON.parse(localStorage.getItem("lady_promo_state")) || {};
      promoCode = (st.code || "").trim();
    } catch {
    }
    payBtn.setAttribute("disabled", "");
    payBtn.setAttribute("data-busy", "1");
    const txtEl = payBtn.querySelector(".text-block-wrap-div");
    const oldTxt = txtEl == null ? void 0 : txtEl.textContent;
    if (txtEl) txtEl.textContent = "Создаю ссылку…";
    const name = ((_d = form == null ? void 0 : form.querySelector('input[type="text"], [name="name"], [name="fio"]')) == null ? void 0 : _d.value) || "";
    const email = ((_e = form == null ? void 0 : form.querySelector('input[type="email"], [name="email"]')) == null ? void 0 : _e.value) || "";
    const phone = ((_f = form == null ? void 0 : form.querySelector('input[type="tel"],   [name="phone"]')) == null ? void 0 : _f.value) || "";
    const address = ((_g = form == null ? void 0 : form.querySelector('input[placeholder*="Адрес"], input[placeholder*="адрес"]')) == null ? void 0 : _g.value) || "";
    const allSelects = (form == null ? void 0 : form.querySelectorAll("select")) || [];
    let contactPref = "";
    for (const select of allSelects) {
      const options = Array.from(select.options || []);
      const hasContactOptions = options.some(
        (opt) => /telegram|whatsapp|позвонить/i.test(opt.textContent || opt.value || "")
      );
      if (hasContactOptions) {
        const selectedOption = options.find((opt) => opt.selected);
        if (selectedOption) {
          contactPref = selectedOption.textContent || selectedOption.value || "";
          break;
        }
      }
    }
    const unlock = lockThanksRedirect();
    try {
      const firstItem = cart[0];
      const oid = `LE-${Date.now()}-${(firstItem == null ? void 0 : firstItem.height) || ""}`;
      const itemsList = cart.map((item) => {
        const price = Number(String(item.price || 0).replace(/[^\d.-]/g, "")) || 0;
        const qty = Number(item.qty || 1);
        const itemTotal = price * qty;
        return `${item.name || "Товар"}${item.height ? ` ${item.height} см` : ""}${item.category ? ` (${item.category})` : ""}${qty > 1 ? ` x${qty}` : ""} — ${itemTotal} ₽`;
      }).join(" | ");
      let descr = itemsList;
      if (name) descr += ` | Покупатель: ${name}`;
      if (email) descr += ` | Почта: ${email}`;
      if (phone) descr += ` | Телефон: ${phone}`;
      if (address) descr += ` | Адрес: ${address}`;
      if (contactPref) descr += ` | Связь: ${contactPref}`;
      if (promoCode) descr += ` | Промо: ${promoCode}`;
      descr = descr.trim();
      const baseAmount = cart.reduce((sum, item) => {
        const price = Number(String(item.price || 0).replace(/[^\d.-]/g, "")) || 0;
        const qty = Number(item.qty || 1);
        return sum + price * qty;
      }, 0);
      let totalAmount = baseAmount;
      let promoDiscountLabel = "";
      let promoGiftLabel = "";
      try {
        const promoState = JSON.parse(localStorage.getItem("lady_promo_state") || "null");
        if (promoState && promoState.rub > 0) {
          totalAmount = Math.max(0, baseAmount - promoState.rub);
          promoDiscountLabel = `${promoState.rub} ₽`;
        } else if (promoState && promoState.pct > 0) {
          totalAmount = Math.max(0, Math.round(baseAmount * (1 - promoState.pct / 100)));
          promoDiscountLabel = `${promoState.pct}% (${Math.max(0, baseAmount - totalAmount)} ₽)`;
        }
        if (promoState && promoState.gift) promoGiftLabel = promoState.giftText || "да";
      } catch (e) {
      }
      if (promoDiscountLabel) descr += ` | Скидка по промокоду: ${promoDiscountLabel}`;
      if (promoGiftLabel) descr += ` | Подарок по промокоду: ${promoGiftLabel}`;
      const payload = {
        amount: totalAmount,
        description: descr,
        email,
        phone,
        orderId: oid,
        clientId: (name || "").trim() || "Леди Елка",
        successUrl: location.origin + `/spasibo?oid=${encodeURIComponent(oid)}`,
        failUrl: location.origin + `/pay-return?fail=1&oid=${encodeURIComponent(oid)}`,
        promoCode: promoCode || "",
        address: address || "",
        contactPref: contactPref || ""
      };
      if (payload.amount <= 0 || !Number.isFinite(payload.amount)) {
        unlock();
        alert("Сумма оплаты нулевая");
        touchStartTarget = null;
        return;
      }
      const payFn = window.openPayInNewTab || openPayInNewTab;
      if (typeof payFn !== "function") {
        unlock();
        alert("Функция оплаты не загружена. Перезагрузите страницу.");
        touchStartTarget = null;
        return;
      }
      payFn(payload);
      platformSubmit(form);
      setTimeout(unlock, 3e3);
    } catch (e) {
      unlock();
      console.error("Pay link error:", e);
      alert("Не удалось создать ссылку на оплату: " + ((e == null ? void 0 : e.message) || "неизвестная ошибка"));
    } finally {
      payBtn.removeAttribute("disabled");
      payBtn.removeAttribute("data-busy");
      if (txtEl && oldTxt) txtEl.textContent = oldTxt;
      touchStartTarget = null;
    }
  }, true);
  function neuterPayAnchors() {
    document.querySelectorAll("[data-cart-popup] a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      if (isThankUrl(href)) {
        a.dataset._href = href;
        a.removeAttribute("href");
      }
    });
    document.querySelectorAll("[data-cart-popup] [data-pay-now]").forEach((btn) => {
      const a = btn.closest("a[href]");
      if (!a) return;
      a.dataset._href = a.getAttribute("href");
      a.removeAttribute("href");
    });
  }
  neuterPayAnchors();
  document.addEventListener("submit", (e) => {
    var _a;
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!form.closest("[data-cart-popup]")) return;
    if (!validatePopupForm(form)) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      (_a = form.reportValidity) == null ? void 0 : _a.call(form);
      return;
    }
    const mode = getPayMode();
    if (mode === "card") {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      const payBtn = form.querySelector("[data-pay-now]");
      if (payBtn) {
        payBtn.dispatchEvent(new PointerEvent("click", { bubbles: true, cancelable: true }));
      }
      return;
    }
    const formTarget = form.getAttribute("target");
    if (formTarget === "le-silent-frame") {
      return;
    }
  }, true);
  (function() {
    var CART_KEY = "cart";
    var PROMO_KEY = "lady_promo_state";
    function toNum(s) {
      return Number(String(s || "").replace(/[^\d.-]/g, ""));
    }
    function rub2(n) {
      return (Number(n) || 0).toLocaleString("ru-RU") + " ₽";
    }
    var norm2 = function(s) {
      if (typeof window !== "undefined" && window.norm && typeof window.norm === "function") {
        return window.norm(s);
      }
      return String(s || "").trim().toLowerCase().replace(/[ёЁ]/g, "е").replace(/\s+/g, " ");
    };
    function setTxt(node, txt) {
      if (!node) return;
      var span = node.querySelector ? node.querySelector(".text-block-wrap-div") : null;
      if (span) {
        span.textContent = txt;
      } else {
        node.textContent = txt;
      }
    }
    function ensureToastHost() {
      var host = document.getElementById("le-toast-host");
      if (!host) {
        host = document.createElement("div");
        host.id = "le-toast-host";
        host.style.position = "fixed";
        host.style.left = "50%";
        host.style.bottom = "20px";
        host.style.transform = "translateX(-50%)";
        host.style.zIndex = "2147483647";
        host.style.display = "flex";
        host.style.flexDirection = "column";
        host.style.gap = "10px";
        host.style.pointerEvents = "none";
        document.body.appendChild(host);
      }
      return host;
    }
    function toast(text, type, ms) {
      var host = ensureToastHost();
      var box = document.createElement("div");
      var ico = type === "ok" ? String.fromCodePoint(9989) : (
        // &#x2705;
        type === "warn" ? String.fromCodePoint(9888, 65039) : (
          // &#x26A0;️
          String.fromCodePoint(10060)
        )
      );
      ico = ico.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
      box.textContent = ico + " " + String(text || "");
      box.style.pointerEvents = "auto";
      box.style.padding = "10px 14px";
      box.style.borderRadius = "12px";
      box.style.boxShadow = "0 10px 24px rgba(0,0,0,.15)";
      box.style.font = "14px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial";
      box.style.background = type === "ok" ? "#e8f9ee" : type === "warn" ? "#fff6e5" : "#ffecec";
      box.style.border = "1px solid " + (type === "ok" ? "#86d3a0" : type === "warn" ? "#f0c36d" : "#f1a7a7");
      box.style.transition = "transform .18s ease, opacity .18s ease";
      box.style.opacity = "0";
      box.style.transform = "translateY(6px)";
      host.appendChild(box);
      setTimeout(() => {
        box.style.opacity = "1";
        box.style.transform = "translateY(0)";
      }, 10);
      var ttl = typeof ms === "number" && ms > 0 ? ms : 2400;
      setTimeout(() => {
        box.style.opacity = "0";
        box.style.transform = "translateY(6px)";
      }, ttl - 220);
      setTimeout(() => {
        box.remove();
      }, ttl);
    }
    function getCart2() {
      if (typeof window.getCart === "function") return window.getCart();
      try {
        return JSON.parse(localStorage.getItem(CART_KEY) || "[]") || [];
      } catch (e) {
        return [];
      }
    }
    function setCart2(arr) {
      if (typeof window.setCart === "function") return window.setCart(arr);
      try {
        localStorage.setItem(CART_KEY, JSON.stringify(arr || []));
      } catch (e) {
      }
    }
    function getPromoState() {
      try {
        var raw = localStorage.getItem(PROMO_KEY);
        if (raw && raw !== "null") return JSON.parse(raw);
      } catch (e) {
      }
      return null;
    }
    function setPromoState(st) {
      try {
        localStorage.setItem(PROMO_KEY, JSON.stringify(st || null));
      } catch (e) {
      }
    }
    function ui() {
      var btn = document.querySelector("[data-promo-apply]");
      var input = document.querySelector("[data-promo-input]");
      var sum = document.querySelector("[data-cart-sum] .text-block-wrap-div") || document.querySelector("[data-cart-sum]");
      var oldT = document.querySelector("[data-cart-sum-old] .text-block-wrap-div") || document.querySelector("[data-cart-sum-old]");
      var saleTxt = document.querySelector("[data-cart-sum-offer] .text-block-wrap-div") || document.querySelector("[data-cart-sum-offer]");
      var oldWrap = null;
      var ow = document.querySelector("[data-cart-sum-old]");
      if (ow && ow.closest) {
        oldWrap = ow.closest(".offer-wrapper__product");
      }
      if (!oldWrap) {
        oldWrap = document.querySelector(".offer-wrapper__product");
      }
      var form = null;
      if (btn && btn.closest) {
        form = btn.closest("form");
      }
      return { btn, input, sumTxt: sum, oldWrap, oldTxt: oldT, saleTxt, form };
    }
    function render() {
      var u = ui();
      var cart = getCart2();
      if (!cart.length) return;
      var st = getPromoState();
      var promoActive = !!(st && (st.rub > 0 || st.pct > 0 || st.gift));
      if (typeof window.updateCartTotal === "function") {
        window.updateCartTotal();
      } else {
        updateCartTotal();
      }
      if (u.btn) {
        u.btn.setAttribute("data-mode", promoActive ? "reset" : "apply");
        var t = u.btn.querySelector(".text-block-wrap-div");
        if (t) t.textContent = promoActive ? "сбросить" : "активировать";
      }
      if (u.input) {
        if (st && st.code) {
          u.input.value = st.code;
        } else {
          u.input.value = "";
        }
      }
      document.querySelectorAll("[data-bag-wrapper]").forEach((bag) => {
        const show = !!(st && st.gift);
        bag.toggleAttribute("data-on", show);
        bag.style.setProperty("display", show ? "flex" : "none", "important");
      });
      if (u.form) {
        var ct = u.form.querySelector('[name="cart_total"]');
        var ci = u.form.querySelector('[name="cart_items"]');
        var baseTotal = cart.reduce(function(sum, item) {
          return sum + toNum(item.price || 0) * (item.qty || 1);
        }, 0);
        var finalTotal = baseTotal;
        if (st && st.rub > 0) {
          finalTotal = Math.max(0, baseTotal - st.rub);
        } else if (st && st.pct > 0) {
          finalTotal = Math.max(0, Math.round(baseTotal * (1 - st.pct / 100)));
        }
        if (ct) ct.setAttribute("value", String(finalTotal));
        if (ci) {
          try {
            var arr = JSON.parse(ci.value || "[]");
            if (arr && Array.isArray(arr)) {
              arr.forEach(function(item, idx) {
                if (cart[idx]) item.price = toNum(cart[idx].price || 0);
              });
              ci.value = JSON.stringify(arr);
            }
          } catch (e) {
          }
        }
      }
    }
    function promoCsvParse(t) {
      var out = [], row = [], i = 0, c = "", q = false;
      while (i < t.length) {
        var h = t[i];
        if (q) {
          if (h == '"' && t[i + 1] == '"') {
            c += '"';
            i += 2;
            continue;
          }
          if (h == '"') {
            q = false;
            i++;
            continue;
          }
          c += h;
          i++;
          continue;
        }
        if (h == '"') {
          q = true;
          i++;
          continue;
        }
        if (h == ",") {
          row.push(c);
          c = "";
          i++;
          continue;
        }
        if (h == "\n") {
          row.push(c);
          out.push(row.slice());
          row.length = 0;
          c = "";
          i++;
          continue;
        }
        if (h == "\r") {
          i++;
          continue;
        }
        c += h;
        i++;
      }
      if (c.length || row.length) {
        row.push(c);
        out.push(row);
      }
      return out;
    }
    var PROMO_CACHE = null;
    function loadPromos(cb) {
      if (PROMO_CACHE) {
        cb(PROMO_CACHE);
        return;
      }
      fetch(PROMO_SHEET_CSV_URL, { cache: "no-store" }).then(function(r) {
        return r.text();
      }).then(function(txt) {
        var rows = promoCsvParse(txt);
        var obj = {};
        if (!rows.length) {
          PROMO_CACHE = obj;
          cb(obj);
          return;
        }
        var head = rows.shift().map(function(h) {
          return String(h || "").trim().toLowerCase();
        });
        function col(names) {
          for (var i = 0; i < names.length; i++) {
            var idx = head.indexOf(names[i]);
            if (idx >= 0) return idx;
          }
          return -1;
        }
        var iCode = col(["promocode", "promo", "code", "код", "промокод", "прмокод"]);
        var iRub = col(["ruble-offer", "ruble", "rub-off", "rub", "скидка в рублях", "руб", "рубли"]);
        var iPct = col(["percent-offer", "percent", "pct", "%", "скидка в %", "процент", "проценты"]);
        var iGift = col(["gift-offer", "gift", "gift_offer", "подарок"]);
        for (var r = 0; r < rows.length; r++) {
          var row = rows[r];
          var code = norm2(row[iCode] || "");
          if (!code) continue;
          var rubV = toNum(String(row[iRub] || "").replace(",", "."));
          var pctV = toNum(String(row[iPct] || "").replace(",", "."));
          var giftRaw = iGift >= 0 ? String(row[iGift] || "").trim() : "";
          var gift = /сумк/i.test(giftRaw);
          obj[code] = { rub: rubV, pct: pctV, gift, giftRaw };
        }
        PROMO_CACHE = obj;
        cb(obj);
      }).catch(function(err) {
        console.warn("Promo CSV load error:", err);
        toast("База промокодов не загрузилась", "err", 3e3);
        cb({});
      });
    }
    function applyByInput() {
      var u = ui();
      var cart = getCart2();
      if (!cart.length) {
        toast("Добавьте товар в корзину", "warn");
        return;
      }
      var onlyDecor = cart.length > 0 && cart.every(function(item) {
        var category = String(item.category || "").trim();
        return category === "Декор";
      });
      if (onlyDecor) {
        toast("Промокоды не применяются к декору", "warn");
        return;
      }
      var codeRaw = u.input && u.input.value ? u.input.value : "";
      var code = norm2(codeRaw);
      if (!code) {
        toast("Введите промокод", "warn");
        return;
      }
      var cur = getPromoState();
      if (!cur) {
      } else if (cur && (cur.rub > 0 || cur.pct > 0 || cur.gift) && norm2(cur.code) !== code) {
        toast("Уже применён промокод «" + cur.code + "». Сначала сбросьте.", "warn", 3e3);
        return;
      } else if (cur && norm2(cur.code) === code) {
        resetPromo();
        return;
      }
      loadPromos(function(list) {
        var rec = list[code];
        if (!rec) {
          toast("Промокод не подходит", "err");
          return;
        }
        if (!(rec.rub > 0 || rec.pct > 0 || rec.gift)) {
          toast("Промокод не дает ни скидку, ни подарок", "warn");
          return;
        }
        var baseTotal = 0;
        cart.forEach(function(item) {
          if (typeof item.basePrice !== "number") {
            item.basePrice = toNum(item.price || 0);
          }
          baseTotal += item.basePrice * (item.qty || 1);
        });
        setPromoState({
          code: (codeRaw || "").trim(),
          rub: rec.rub || 0,
          pct: rec.pct || 0,
          baseTotal,
          gift: !!rec.gift,
          giftText: rec.giftRaw || ""
        });
        render();
        toast(rec.gift && (rec.rub > 0 || rec.pct > 0) ? "Скидка и подарок активированы" : rec.gift ? "Подарок активирован" : "Промокод активирован", "ok");
      });
    }
    function resetPromo() {
      var cart = getCart2();
      if (!cart.length) {
        toast("Корзина пуста", "warn");
        return;
      }
      var st = getPromoState();
      if (!st) {
        toast("Промокод еще не применен", "warn");
        return;
      }
      cart.forEach(function(item) {
        delete item.basePrice;
      });
      setCart2(cart);
      setPromoState(null);
      var u = ui();
      if (u.input) u.input.value = "";
      render();
      document.querySelectorAll("[data-bag-wrapper]").forEach((bag) => {
        bag.removeAttribute("data-on");
        bag.style.setProperty("display", "none", "important");
      });
      toast("Промокод сброшен", "ok");
    }
    document.addEventListener("click", function(e) {
      var btn = e.target.closest && e.target.closest("[data-promo-apply]");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      var mode = btn.getAttribute("data-mode") || "apply";
      if (mode === "reset") resetPromo();
      else applyByInput();
    }, true);
    document.addEventListener("keydown", function(e) {
      if (e.key !== "Enter") return;
      var input = e.target.closest && e.target.closest("[data-promo-input]");
      if (!input) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      applyByInput();
    }, true);
    render();
    window.addEventListener("storage", function(ev) {
      if (ev && (ev.key === PROMO_KEY || ev.key === CART_KEY)) {
        render();
      }
    });
    window.LE_Promo = Object.assign({}, window.LE_Promo, {
      reset: resetPromo,
      apply: applyByInput,
      state: getPromoState,
      render
    });
    var popupEl = document.querySelector("[data-cart-popup]");
    function isOpen(el) {
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden" && !el.hasAttribute("hidden");
    }
    if (popupEl) {
      var wasOpen = isOpen(popupEl);
      new MutationObserver(function() {
        try {
          const nowOpen = isOpen(popupEl);
          if (!wasOpen && nowOpen) {
            const st = getPromoState();
            if (st && (st.rub > 0 || st.pct > 0 || st.gift)) {
              var cart = getCart2();
              if (cart.length) {
                var baseTotal = 0;
                cart.forEach(function(item) {
                  if (typeof item.basePrice !== "number") {
                    item.basePrice = toNum(item.price || 0);
                  }
                  baseTotal += item.basePrice * (item.qty || 1);
                });
                st.baseTotal = baseTotal;
                setPromoState(st);
                if (typeof window.updateCartTotal === "function") {
                  window.updateCartTotal();
                }
              }
            }
          }
          render();
          wasOpen = nowOpen;
        } catch (e) {
        }
      }).observe(popupEl, { attributes: true, attributeFilter: ["style", "class", "hidden"] });
    }
  })();
})();

