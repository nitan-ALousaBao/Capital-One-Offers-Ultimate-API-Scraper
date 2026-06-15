// ==UserScript==
// @name         Capital One Offers Ultimate (v47.6)
// @namespace    http://tampermonkey.net/
// @version      47.6
// @description  完整版：脱离 Body 独立挂载，静默重生，告别 React 冲突
// @author       ALousaBao
// @match        https://capitaloneshopping.com/*
// @match        https://capitaloneoffers.com/*
// @updateURL    https://raw.githubusercontent.com/nitan-ALousaBao/Capital-One-Offers-Ultimate-API-Scraper/refs/heads/main/c1_offer_script_with_gmails_miles.js
// @downloadURL  https://raw.githubusercontent.com/nitan-ALousaBao/Capital-One-Offers-Ultimate-API-Scraper/refs/heads/main/c1_offer_script_with_gmails_miles.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @connect      capitaloneoffers.com
// @connect      google.com
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    let currentData = [];
    let shadow = null;
    let sortConfig = { key: 'reward', dir: 'desc' };
    let counts = { web: 0, email: 0, miles: 0 };
    let uiHostElement = null;
    let webDomMergeObserver = null;
    let webDomMergeTimer = null;
    let domOfferActionSeq = 0;
    const domOfferActionMap = new Map();

    const getConfig = () => ({
        url: (GM_getValue('c1_api_url', '')).trim(),
        state: GM_getValue('c1_state', 'NJ'),
        zip: GM_getValue('c1_zip', '07302'),
        val: parseFloat(GM_getValue('c1_valuation', '1.6')) || 1.6,
        milesDisabled: GM_getValue('c1_miles_disabled', false)
    });

    const generateUUID = () => {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    };

    const gmFetch = (url, options) => new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: options.method || 'GET',
            url: url,
            headers: options.headers,
            data: options.body,
            onload: (res) => {
                try {
                    resolve({ json: () => Promise.resolve(JSON.parse(res.responseText)) });
                } catch(e) { reject(e); }
            },
            onerror: reject
        });
    });

    function updateStatus(msg = null) {
        if (!shadow) return;
        const bar = shadow.getElementById('status-bar');
        const conf = getConfig();
        if (msg) bar.innerText = msg;
        else {
            let statusHtml = `<span style="color:#fff">W:${counts.web}</span> | <span style="color:#fff">E:${counts.email}</span>`;
            if (!conf.milesDisabled) statusHtml += ` | <span style="color:#fff">M:${counts.miles}</span>`;
            bar.innerHTML = statusHtml;
        }
    }

    function toggleExpand(force = null) {
        if (!shadow) return;
        const card = shadow.getElementById('card');
        const btn = shadow.getElementById('btn-toggle');
        const isExp = force !== null ? force : !card.classList.contains('exp');
        if (isExp) { card.classList.add('exp'); btn.innerText = '[−]'; }
        else { card.classList.remove('exp'); btn.innerText = '[+]'; }
    }

    GM_addValueChangeListener('distributed_miles_payload', (n, o, val) => {
        if (!val || getConfig().milesDisabled) return;
        const payload = JSON.parse(val);
        payload.data.forEach(item => {
            if (!currentData.some(i => i.merchant === item.merchant && i.reward === item.reward)) {
                currentData.push(item); counts.miles++;
            }
        });
        refreshDisplay(); updateStatus();
    });

    function extractSpendBackRewardFromText(text) {
        const match = String(text || '').replace(/\s+/g, ' ').match(/get\s+\$?([\d,.]+)\s+back\s+when\s+you\s+spend\s+\$?([\d,.]+)\+?/i);
        return match ? `Get $${match[1]} back when you spend $${match[2]}` : '';
    }

    function normalizeMerchantName(name) {
        return String(name || '')
            .toLowerCase()
            .replace(/&/g, 'and')
            .replace(/\b(the|inc|llc|ltd|co|company)\b/g, '')
            .replace(/\.(com|net|org|us|co|shop|store)\b/g, '')
            .replace(/[^a-z0-9]+/g, '');
    }

    function escapeRegExp(text) {
        return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function extractSpendBackReward(item) {
        const seen = new Set();
        const strings = [];
        function walk(value, depth = 0) {
            if (value == null || depth > 5) return;
            if (typeof value === 'string') {
                const text = value.replace(/\s+/g, ' ').trim();
                if (text) strings.push(text);
                return;
            }
            if (typeof value !== 'object' || seen.has(value)) return;
            seen.add(value);
            if (Array.isArray(value)) {
                value.forEach(v => walk(v, depth + 1));
                return;
            }
            Object.entries(value).forEach(([key, child]) => {
                if (/href|url|image|logo|src|icon/i.test(key)) return;
                walk(child, depth + 1);
            });
        }
        walk(item);
        return extractSpendBackRewardFromText(strings.join(' '));
    }

    function formatCents(cents) {
        const n = Number(cents);
        if (!Number.isFinite(n)) return '';
        const dollars = n / 100;
        return `$${Number.isInteger(dollars) ? dollars.toFixed(0) : dollars.toFixed(2)}`;
    }

    function extractThresholdReward(item) {
        const tiers = item?.stats?.rewardTiers;
        if (!Array.isArray(tiers) || !tiers.length) return '';
        const tier = tiers
            .filter(t => t?.reward)
            .sort((a, b) => (Number(b?.reward?.value) || 0) - (Number(a?.reward?.value) || 0))[0];
        if (!tier) return '';

        const reward = tier?.reward?.displayValue || formatCents(tier?.reward?.value);
        const spend = tier?.displaySpendValue || tier?.displaySpendCents || formatCents(tier?.spendCents);
        if (!reward || !spend) return '';
        return `Get ${reward} back when you spend ${spend}`;
    }

    function buildDomSpendBackRewardQueues(root = document) {
        const queues = {};
        const cards = Array.from(root.querySelectorAll('.deal-list-item, [data-test-merchant-name]'))
            .map(el => el.closest('.deal-list-item') || el);
        cards.forEach(card => {
            if (!card) return;
            const reward = extractSpendBackRewardFromText(card.textContent);
            if (!reward) return;
            const merchant = (card.getAttribute('data-test-merchant-name')
                || card.querySelector('[data-testid="deal-item-merchant-name"]')?.textContent
                || '').replace(/\s+/g, ' ').trim();
            if (!merchant) return;
            const key = normalizeMerchantName(merchant);
            const action = extractDomOfferAction(card);
            if (!queues[key]) queues[key] = { merchant, offers: [] };
            if (!queues[key].offers.some(offer => offer.reward === reward && offer.link === action.link && offer.actionId === action.actionId)) {
                queues[key].offers.push({ reward, link: action.link, actionId: action.actionId });
            }
        });
        return queues;
    }

    function extractDomOfferAction(card) {
        const link = Array.from(card.querySelectorAll('a[href]'))
            .find(el => /get this offer|go|shop|view/i.test(el.textContent || '') || el.href);
        if (link?.href) return { link: link.href, actionId: '' };

        const button = Array.from(card.querySelectorAll('button, [role="button"]'))
            .find(el => /get this offer|go|shop|view/i.test(el.textContent || ''));
        const target = button || card;
        const attrLink = target?.getAttribute?.('href')
            || target?.getAttribute?.('data-href')
            || target?.getAttribute?.('data-url')
            || target?.dataset?.href
            || target?.dataset?.url
            || '';
        if (attrLink) return { link: attrLink, actionId: '' };

        const actionId = `dom-${++domOfferActionSeq}`;
        domOfferActionMap.set(actionId, target);
        return { link: '', actionId };
    }

    function takeDomSpendBackReward(queues, merchant) {
        const key = normalizeMerchantName(merchant);
        let queue = queues[key];
        if (!queue || !queue.offers.length) {
            const fuzzyKey = Object.keys(queues).find(k => k && key && (k.includes(key) || key.includes(k)));
            queue = fuzzyKey ? queues[fuzzyKey] : null;
        }
        return queue && queue.offers.length ? queue.offers[0].reward : findPageSpendBackRewardNearMerchant(merchant);
    }

    function findPageSpendBackRewardNearMerchant(merchant) {
        const pageText = String(document.body?.innerText || document.body?.textContent || '').replace(/\s+/g, ' ');
        const cleanMerchant = String(merchant || '').replace(/\.(com|net|org|us|co|shop|store)\b/ig, '').replace(/\s+/g, ' ').trim();
        if (!pageText || !cleanMerchant) return '';

        const after = pageText.match(new RegExp(`${escapeRegExp(cleanMerchant)}.{0,500}?get\\s+\\$?[\\d,.]+\\s+back\\s+when\\s+you\\s+spend\\s+\\$?[\\d,.]+`, 'i'));
        if (after) return extractSpendBackRewardFromText(after[0]);

        const before = pageText.match(new RegExp(`get\\s+\\$?[\\d,.]+\\s+back\\s+when\\s+you\\s+spend\\s+\\$?[\\d,.]+.{0,500}?${escapeRegExp(cleanMerchant)}`, 'i'));
        return before ? extractSpendBackRewardFromText(before[0]) : '';
    }

    function domSpendBackQueuesToItems(queues) {
        return Object.values(queues).flatMap(queue =>
            queue.offers.map(offer => ({
                merchant: queue.merchant,
                reward: offer.reward,
                exclusions: 'From page offer',
                link: offer.link || '',
                actionId: offer.actionId || '',
                source: 'web'
            }))
        );
    }

    function mergeDomSpendBackRewards(queues) {
        let changed = false;
        Object.entries(queues).forEach(([key, queue]) => {
            queue.offers.forEach(offer => {
                const exact = currentData.find(item =>
                    item.source === 'web'
                    && normalizeMerchantName(item.merchant) === key
                    && item.reward === offer.reward
                );
                if (exact) return;

                const blank = currentData.find(item =>
                    item.source === 'web'
                    && normalizeMerchantName(item.merchant) === key
                    && !String(item.reward || '').trim()
                );
                if (blank) {
                    blank.reward = offer.reward;
                    if (offer.link && !blank.link) blank.link = offer.link;
                    if (offer.actionId && !blank.actionId) blank.actionId = offer.actionId;
                    changed = true;
                    return;
                }

                currentData.push({
                    merchant: queue.merchant,
                    reward: offer.reward,
                    exclusions: 'From page offer',
                    link: offer.link || '',
                    actionId: offer.actionId || '',
                    source: 'web'
                });
                counts.web++;
                changed = true;
            });
        });

        currentData.forEach(item => {
            if (item.source !== 'web' || String(item.reward || '').trim()) return;
            const reward = findPageSpendBackRewardNearMerchant(item.merchant);
            if (reward) {
                item.reward = reward;
                changed = true;
            }
        });
        return changed;
    }

    function mergeWebDomRewardsAndRefresh() {
        if (!currentData.some(item => item.source === 'web')) return;
        if (mergeDomSpendBackRewards(buildDomSpendBackRewardQueues())) {
            refreshDisplay();
            updateStatus();
        }
    }

    function scheduleWebDomRewardMerge(delay = 250) {
        clearTimeout(webDomMergeTimer);
        webDomMergeTimer = setTimeout(mergeWebDomRewardsAndRefresh, delay);
    }

    function watchWebDomRewards() {
        if (webDomMergeObserver || !document.body) return;
        webDomMergeObserver = new MutationObserver(() => scheduleWebDomRewardMerge(400));
        webDomMergeObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    function getWeight(s) {
        if (!s) return { type: 0, val: 0 };
        s = String(s);
        const conf = getConfig();
        const n = parseFloat(s.replace(/,/g, '').match(/(\d+(\.\d+)?)/)?.[1] || 0);
        if (s.includes('$')) return { type: 3, val: n };
        if (s.includes('%') || s.includes('✈️')) {
            let effectiveVal = n;
            if (s.includes('✈️')) {
                effectiveVal = s.toLowerCase().includes('x') ? (n * conf.val) : ((n * conf.val) / 100);
            }
            return { type: 2, val: effectiveVal };
        }
        return { type: 0, val: n };
    }

    function pushDataBatch(newItems, type) {
        if (!Array.isArray(newItems)) return 0;
        let added = 0;
        newItems.forEach(item => {
            const next = { merchant: item.merchant, reward: item.reward, exclusions: item.exclusions, link: item.link, actionId: item.actionId || '', source: type };
            const nextKey = normalizeMerchantName(next.merchant);
            const nextReward = String(next.reward || '').trim();
            if (nextReward && currentData.some(existing =>
                existing.source === type
                && normalizeMerchantName(existing.merchant) === nextKey
                && String(existing.reward || '').trim() === nextReward
            )) return;
            currentData.push(next);
            counts[type]++;
            added++;
        });
        updateStatus();
        return added;
    }

    function refreshDisplay() {
        if (!shadow) return;
        const conf = getConfig();
        const filterVal = shadow.getElementById('f-src').value;
        const searchInput = shadow.getElementById('search-in').value.toLowerCase();
        shadow.getElementById('btn-miles').style.display = conf.milesDisabled ? 'none' : 'block';
        shadow.getElementById('btn-group-box').style.gridTemplateColumns = conf.milesDisabled ? '1fr 1fr' : '1fr 1fr 1fr';
        shadow.getElementById('th-name').querySelector('span').innerText = ` ${sortConfig.key === 'name' ? (sortConfig.dir === 'asc' ? '↑' : '↓') : '⇅'}`;
        shadow.getElementById('th-reward').querySelector('span').innerText = ` ${sortConfig.key === 'reward' ? (sortConfig.dir === 'asc' ? '↑' : '↓') : '⇅'}`;

        let data = [...currentData];
        if (conf.milesDisabled) data = data.filter(i => i.source !== 'miles');
        if (searchInput) data = data.filter(i => i.merchant.toLowerCase().includes(searchInput));
        if (filterVal === 'email') data = data.filter(i => i.reward.includes('💌'));
        else if (filterVal === 'miles') data = data.filter(i => i.reward.includes('✈️'));
        else if (filterVal === 'web') data = data.filter(i => !i.reward.includes('💌') && !i.reward.includes('✈️'));

        const groups = {};
        data.forEach(i => {
            const k = i.merchant.toLowerCase();
            if (!groups[k]) groups[k] = { name: i.merchant, items: [] };
            groups[k].items.push(i);
        });

        const arr = Object.values(groups);
        arr.forEach(g => g.items.sort((a,b) => {
            const wA = getWeight(a.reward), wB = getWeight(b.reward);
            return wA.type === wB.type ? (wB.val - wA.val) : (wB.type - wA.type);
        }));

        arr.sort((a, b) => {
            let res = 0;
            if (sortConfig.key === 'name') res = a.name.localeCompare(b.name);
            else {
                const wA = getWeight(a.items[0].reward), wB = getWeight(b.items[0].reward);
                res = wA.type === wB.type ? (wA.val - wB.val) : (wA.type - wB.type);
            }
            return sortConfig.dir === 'asc' ? res : -res;
        });

        const tbody = shadow.getElementById('tbody');
        tbody.innerHTML = '';
        arr.forEach((g, idx) => {
            const best = g.items[0];
            const gid = `g-${idx}`;
            const tr = document.createElement('tr');
            if(best.reward.includes('✈️')) tr.style.borderLeft = '4px solid #0ea5e9';
            if(best.reward.includes('💌')) tr.style.backgroundColor = '#fff7ed';

            const actionCell = (best.source === 'miles')
                ? `<small style="color:#64748b; font-weight:600;">✈️ Miles Offer</small>`
                : `<button type="button" class="act" data-h="${best.link}" data-dom-action="${best.actionId || ''}">🚀 Go</button>`;

            tr.innerHTML = `<td style="width:180px"><strong>${best.merchant}</strong> ${g.items.length > 1 ? `<button type="button" class="tgl" data-t="${gid}">▶ ${g.items.length-1}</button>` : ''}</td><td style="color:#15803d; font-weight:bold; width:120px;">${best.reward}</td><td style="width:80px">${actionCell}</td><td style="color:#64748b; font-size:11px;">${best.exclusions || 'None'}</td>`;
            tbody.appendChild(tr);

            if(g.items.length > 1) {
                g.items.slice(1).forEach(c => {
                    const ctr = document.createElement('tr');
                    ctr.className = `child ${gid}`;
                    ctr.style.display = 'none';
                    ctr.style.backgroundColor = '#f8fafc';
                    const childAction = (c.source === 'miles')
                        ? `<small style="color:#94a3b8;">✈️ Miles</small>`
                        : `<button type="button" class="act" data-h="${c.link}" data-dom-action="${c.actionId || ''}">🚀</button>`;
                    ctr.innerHTML = `<td style="padding-left:25px; color:#475569;">↳ ${c.merchant}</td><td style="color:#475569;">${c.reward}</td><td>${childAction}</td><td style="font-size:11px; color:#94a3b8;">${c.exclusions || 'None'}</td>`;
                    tbody.appendChild(ctr);
                });
            }
        });
    }

    async function fetchWeb() {
        counts.web = 0; currentData = currentData.filter(i => i.source !== 'web');
        const conf = getConfig();
        let webToken = null, pages = 0;
        while (pages < 25) {
            try {
                const domSpendBackRewards = buildDomSpendBackRewardQueues();
                const res = await gmFetch('https://capitaloneshopping.com/api/v1/feed', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ "contentProps": {"pagination": {"limit": 100, ...(webToken?{"nextPageToken":webToken}:{})}}, "context": {"location": {"state": conf.state, "zipcode": conf.zip}}})
                });
                const d = await res.json();
                if (!d.items || !Array.isArray(d.items)) break;

                pushDataBatch(domSpendBackQueuesToItems(domSpendBackRewards), 'web');
                pushDataBatch(d.items.map(i => {
                    const rawReward = i?.stats?.cashbackV2 || i?.stats?.cashback || extractThresholdReward(i) || extractSpendBackReward(i) || takeDomSpendBackReward(domSpendBackRewards, i.merchantName || i.merchantDisplayText);
                    const exclusions = i?.stats?.exclusionsText || 'None';
                    return {
                        merchant: i.merchantName || i.merchantDisplayText || 'Unknown',
                        reward: rawReward || '',
                        exclusions,
                        link: i.href || '',
                        source: 'web'
                    };
                }), 'web');
                pushDataBatch(domSpendBackQueuesToItems(buildDomSpendBackRewardQueues()), 'web');
                mergeWebDomRewardsAndRefresh();
                webToken = d.pagination?.nextPageToken;
                pages++; if (!webToken) break;
            } catch(e) { break; }
        }
        pushDataBatch(domSpendBackQueuesToItems(buildDomSpendBackRewardQueues()), 'web');
        mergeDomSpendBackRewards(buildDomSpendBackRewardQueues());
        [250, 1000, 2500, 5000].forEach(delay => setTimeout(mergeWebDomRewardsAndRefresh, delay));
        watchWebDomRewards();
        refreshDisplay();
    }

    function fetchEmail() {
        const conf = getConfig(); if (!conf.url) return;
        counts.email = 0; currentData = currentData.filter(i => i.source !== 'email');
        GM_xmlhttpRequest({
            method: "GET", url: conf.url, timeout: 20000,
            onload: (res) => {
                try {
                    const d = JSON.parse(res.responseText);
                    if(d.items) pushDataBatch(d.items, 'email');
                    refreshDisplay();
                } catch(e) {}
            }
        });
    }

    function fetchMilesDirect() {
        if (getConfig().milesDisabled) return;
        const token = GM_getValue('vx_token_bus', '');
        if (!token) { window.open("https://capitaloneoffers.com/feed", "_blank"); return; }
        counts.miles = 0; currentData = currentData.filter(i => i.source !== 'miles');
        GM_xmlhttpRequest({
            method: "GET", url: `https://capitaloneoffers.com/feed/${token}?contentSlug=ease-web-l1&_data=routes%2Ffeed.%24accountReferenceId`,
            headers: { "x-remix-fetch": "yes", "Accept": "application/json" },
            onload: (res) => {
                try {
                    const json = JSON.parse(res.responseText);
                    let extracted = [];
                    function dfs(obj) {
                        if (Array.isArray(obj)) obj.forEach(dfs);
                        else if (typeof obj === 'object' && obj !== null) {
                            if (obj.merchantTLD && (obj.buttonText || obj.rateText)) {
                                let r = obj.buttonText || obj.rateText || "";
                                if (r.toLowerCase().includes('miles')) {
                                    let n = obj.merchantTLD.split('.')[0].replace(/^\w/, c => c.toUpperCase());
                                    extracted.push({ merchant: n, reward: r + " ✈️", exclusions: '💳 VX Card', link: '', source: 'miles' });
                                }
                            }
                            Object.values(obj).forEach(dfs);
                        }
                    }
                    dfs(json); pushDataBatch(extracted, 'miles'); refreshDisplay();
                } catch(e) {}
            }
        });
    }

    function buildUI() {
        if (window.location.hostname.includes('capitaloneoffers.com')) {
            const token = window.location.pathname.split('/feed/')[1]?.split('?')[0];
            if (token && token.length > 20) GM_setValue('vx_token_bus', token);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'c1-ultimate-isolated-host';
            btn.innerHTML = '🛰️ Sniff & Sync Miles';
            btn.style.cssText = 'position:fixed; bottom:40px; right:40px; z-index:2147483647; padding:20px 30px; background:#10b981; color:white; border:none; border-radius:50px; font-weight:bold; cursor:pointer; box-shadow:0 10px 30px rgba(16,185,129,0.4); font-size:18px; border:3px solid #fff;';
            btn.onclick = (e) => {
                e.preventDefault();
                const resources = performance.getEntriesByType('resource');
                const feedReq = resources.find(r => r.name.includes('/feed/') && r.name.includes('contentSlug='));
                let targetUrl = feedReq ? (feedReq.name.includes('_data=') ? feedReq.name : feedReq.name + "&_data=routes%2Ffeed.%24accountReferenceId") : '';
                if (!targetUrl && token) targetUrl = `https://capitaloneoffers.com/feed/${token}?contentSlug=ease-web-l1&_data=routes%2Ffeed.%24accountReferenceId`;
                GM_xmlhttpRequest({
                    method: "GET", url: targetUrl, headers: { "x-remix-fetch": "yes", "Accept": "application/json" },
                    onload: (res) => {
                        const json = JSON.parse(res.responseText);
                        let extracted = [];
                        function dfs(obj) {
                            if (Array.isArray(obj)) obj.forEach(dfs);
                            else if (typeof obj === 'object' && obj !== null) {
                                if (obj.merchantTLD && (obj.buttonText || obj.rateText)) {
                                    let r = obj.buttonText || obj.rateText || "";
                                    if (r.toLowerCase().includes('miles')) {
                                        let n = obj.merchantTLD.split('.')[0].replace(/^\w/, c => c.toUpperCase());
                                        extracted.push({ merchant: n, reward: r + " ✈️", exclusions: '💳 VX Card', link: '', source: 'miles' });
                                    }
                                }
                                Object.values(obj).forEach(dfs);
                            }
                        }
                        dfs(json);
                        GM_setValue('distributed_miles_payload', JSON.stringify({ ts: Date.now(), data: extracted }));
                        btn.innerHTML = `✅ ${extracted.length} Synced!`;
                        setTimeout(() => window.close(), 1200);
                    }
                });
            };
            uiHostElement = btn;
            return;
        }

        const host = document.createElement('div');
        host.id = 'c1-ultimate-isolated-host';
        host.style.cssText = 'position: fixed; top: 20px; left: 20px; z-index: 2147483647;';

        shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>
                #card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,0.15);width:280px;overflow:hidden;font-family:sans-serif;transition: width 0.3s;}
                #card.exp{width:950px;max-height:85vh;}
                .h{background:#004d73;color:#fff;padding:15px;display:flex;flex-direction:column;gap:10px;cursor:move;user-select:none;}
                .btn-all{background:#f60859; color:white; border:none; padding:10px; border-radius:6px; cursor:pointer; font-weight:bold; font-size:14px;}
                .btn-group{display:grid; gap:5px;}
                .btn-sm{background:rgba(255,255,255,0.15); color:white; border:none; padding:6px; border-radius:4px; cursor:pointer; font-size:11px; font-weight:bold;}
                #btn-toggle{font-family:monospace; background:rgba(255,255,255,0.2); border-radius:4px; padding:2px 6px; font-size:14px; cursor:pointer;}
                .c{display:none;padding:10px;flex-direction:column;height:600px;overflow:hidden;}
                #card.exp .c{display:flex;}
                table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:13px;}
                th{text-align:left;padding:12px 10px;background:#f8fafc;cursor:pointer;color:#475569;border-bottom:2px solid #e2e8f0;}
                td{text-align:left;padding:10px;border-bottom:1px solid #f1f5f9;word-break:break-word;}
                .act{background:#0276b1;color:#fff;border:none;padding:4px 8px;border-radius:4px;font-size:11px;cursor:pointer;}
                .tgl{font-size:10px;background:#e2e8f0;border:none;padding:2px 5px;border-radius:4px;cursor:pointer;}
                .set-row{display:flex; gap:10px; margin-bottom:8px; align-items:center; font-size:11px; color:#475569;}
                .set-row input{padding:4px; border-radius:4px; border:1px solid #ccc;}
            </style>
            <div id="card">
                <div class="h" id="drag-handle">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="font-weight:bold;">⚡ C1 Ultimate</span>
                        <span id="btn-toggle">[+]</span>
                    </div>
                    <button type="button" class="btn-all" id="btn-all">🚀 Start All-Fetch</button>
                    <div class="btn-group" id="btn-group-box"><button type="button" class="btn-sm" id="btn-web">🌐 Web</button><button type="button" class="btn-sm" id="btn-mail">📧 Email</button><button type="button" class="btn-sm" id="btn-miles">✈️ Miles</button></div>
                    <div id="status-bar" style="font-size:11px;color:#bae6fd;text-align:center;font-family:monospace;background:rgba(0,0,0,0.2);padding:4px;border-radius:4px;">Ready.</div>
                    <button type="button" id="stg-btn" style="background:transparent;border:1px solid #fff;color:#fff;font-size:10px;cursor:pointer;width:100%;">⚙️ Settings</button>
                </div>
                <div id="stg-panel" style="display:none;padding:12px;background:#f8fafc;border-bottom:1px solid #ddd;">
                    <div class="set-row"><strong>GAS URL:</strong> <input id="in-url" style="flex:1;"/></div>
                    <div class="set-row"><strong>State:</strong> <input id="in-state" style="width:30px;"/> <strong>Zip:</strong> <input id="in-zip" style="width:50px;"/> <strong>CPP:</strong> <input id="in-val" style="width:40px;"/></div>
                    <div class="set-row"><input type="checkbox" id="in-miles-dis"/> <label for="in-miles-dis"><strong>Disable Miles Module</strong></label></div>
                    <button type="button" id="save-btn" class="btn-all" style="padding:6px 10px; width:100%; background:#004d73; margin-top:5px;">Save Settings</button>
                </div>
                <div class="c">
                    <div style="display:flex;gap:10px;margin-bottom:10px;"><input id="search-in" placeholder="Filter..." style="flex:1;padding:6px;border-radius:4px;border:1px solid #ddd;"/><select id="f-src" style="padding:6px;border-radius:4px;border:1px solid #ddd;"><option value="all">All</option><option value="miles">Miles</option><option value="email">Email</option><option value="web">Web</option></select></div>
                    <div style="overflow-y:auto; flex:1;"><table><thead><tr><th id="th-name" style="width:180px">Merchant<span> ⇅</span></th><th id="th-reward" style="width:120px">Best Reward<span> ⇅</span></th><th style="width:80px">Action</th><th>Notes</th></tr></thead><tbody id="tbody"></tbody></table></div>
                </div>
            </div>
        `;

        let isDragging = false, startX, startY, initialLeft, initialTop;
        const dragHandle = shadow.getElementById('drag-handle');
        dragHandle.onmousedown = (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.id === 'btn-toggle') return;
            isDragging = true; startX = e.clientX; startY = e.clientY; initialLeft = host.offsetLeft; initialTop = host.offsetTop;
            document.onmousemove = (ev) => {
                if (!isDragging) return; host.style.left = (initialLeft + ev.clientX - startX) + 'px'; host.style.top = (initialTop + ev.clientY - startY) + 'px'; host.style.right = 'auto';
            };
            document.onmouseup = () => { isDragging = false; document.onmousemove = null; document.onmouseup = null; };
        };

        dragHandle.onclick = (e) => { if (e.target === dragHandle || (e.target.tagName === 'SPAN' && e.target.id !== 'btn-toggle')) toggleExpand(); };
        shadow.getElementById('btn-toggle').onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleExpand(); };
        shadow.getElementById('btn-all').onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleExpand(true); fetchWeb(); fetchEmail(); if(!getConfig().milesDisabled) fetchMilesDirect(); };
        shadow.getElementById('btn-web').onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleExpand(true); fetchWeb(); };
        shadow.getElementById('btn-mail').onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleExpand(true); fetchEmail(); };
        shadow.getElementById('btn-miles').onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleExpand(true); fetchMilesDirect(); };
        shadow.getElementById('stg-btn').onclick = (e) => { e.preventDefault(); e.stopPropagation(); const p = shadow.getElementById('stg-panel'); p.style.display = p.style.display === 'none' ? 'block' : 'none'; };
        shadow.getElementById('save-btn').onclick = (e) => {
            e.preventDefault();
            GM_setValue('c1_api_url', shadow.getElementById('in-url').value); GM_setValue('c1_state', shadow.getElementById('in-state').value);
            GM_setValue('c1_zip', shadow.getElementById('in-zip').value); GM_setValue('c1_valuation', shadow.getElementById('in-val').value);
            GM_setValue('c1_miles_disabled', shadow.getElementById('in-miles-dis').checked);
            shadow.getElementById('stg-panel').style.display='none'; refreshDisplay(); alert("Saved!");
        };

        shadow.getElementById('th-name').onclick = () => { sortConfig.dir = (sortConfig.key === 'name' && sortConfig.dir === 'asc') ? 'desc' : 'asc'; sortConfig.key = 'name'; refreshDisplay(); };
        shadow.getElementById('th-reward').onclick = () => { sortConfig.dir = (sortConfig.key === 'reward' && sortConfig.dir === 'desc') ? 'asc' : 'desc'; sortConfig.key = 'reward'; refreshDisplay(); };
        shadow.getElementById('search-in').oninput = refreshDisplay;
        shadow.getElementById('f-src').onchange = refreshDisplay;

        shadow.getElementById('tbody').onclick = e => {
            const actBtn = e.target.closest('.act');
            if (actBtn) {
                e.preventDefault();
                const domAction = actBtn.dataset.domAction;
                const domTarget = domAction ? domOfferActionMap.get(domAction) : null;
                if (domTarget && document.contains(domTarget)) {
                    domTarget.click();
                    return;
                }
                let targetUrl = actBtn.dataset.h;
                if (targetUrl) {
                    if (!targetUrl.startsWith('http')) {
                        targetUrl = "https://capitaloneshopping.com" + (targetUrl.startsWith('/') ? '' : '/') + targetUrl;
                    }
                    window.open(targetUrl.replace('__WBCLICKID__', generateUUID()), '_blank');
                }
            }
            if (e.target.classList.contains('tgl')) {
                e.preventDefault();
                const tid = e.target.dataset.t;
                const rows = shadow.querySelectorAll('.' + tid);
                const isHidden = (rows[0].style.display === 'none');
                rows.forEach(r => r.style.display = isHidden ? 'table-row' : 'none');
                e.target.innerText = isHidden ? `▼ Hide` : `▶ ${rows.length}`;
            }
        };

        const initConf = getConfig();
        shadow.getElementById('in-url').value = initConf.url;
        shadow.getElementById('in-state').value = initConf.state;
        shadow.getElementById('in-zip').value = initConf.zip;
        shadow.getElementById('in-val').value = initConf.val;
        shadow.getElementById('in-miles-dis').checked = initConf.milesDisabled;
        refreshDisplay();

        uiHostElement = host;
    }

    function initMount() {
        if (document.getElementById('c1-ultimate-isolated-host')) return;

        buildUI();

        // 核心：挂载在 document.documentElement(即 html 标签) 下，不进 body，避开 React
        if (document.documentElement && uiHostElement) {
            document.documentElement.appendChild(uiHostElement);
        }

        // 静默重生侦听器
        const observer = new MutationObserver((mutations) => {
            let removed = false;
            for (let m of mutations) {
                if (Array.from(m.removedNodes).includes(uiHostElement)) {
                    removed = true;
                    break;
                }
            }
            if (removed) {
                setTimeout(() => {
                    if (document.documentElement && uiHostElement && !document.contains(uiHostElement)) {
                        document.documentElement.appendChild(uiHostElement);
                    }
                }, 500);
            }
        });

        if (document.documentElement) {
            observer.observe(document.documentElement, { childList: true });
        }
    }

    // 延迟 2.5 秒挂载，确保页面原始脚本先执行完毕
    if (document.readyState === 'complete') {
        setTimeout(initMount, 2500);
    } else {
        window.addEventListener('load', () => setTimeout(initMount, 2500));
    }

})();
