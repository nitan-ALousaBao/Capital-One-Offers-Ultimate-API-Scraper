// ==UserScript==
// @name         Capital One Offers Ultimate (v45.1 Auto-Update)
// @namespace    http://tampermonkey.net/
// @version      45.1
// @description  支持 LEGO 满减权重置顶，修正子按钮点击，集成 GitHub 自动更新
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
// ==/UserScript==

(function() {
    'use strict';

    let currentData = [];
    let shadow = null;
    let sortConfig = { key: 'reward', dir: 'desc' };
    let counts = { web: 0, email: 0, miles: 0 };

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

    if (window.location.hostname.includes('capitaloneoffers.com')) {
        const token = window.location.pathname.split('/feed/')[1]?.split('?')[0];
        if (token && token.length > 20) GM_setValue('vx_token_bus', token);
        const btn = document.createElement('button');
        btn.innerHTML = '🛰️ Sniff & Sync Miles';
        btn.style.cssText = 'position:fixed; bottom:40px; right:40px; z-index:2147483647; padding:20px 30px; background:#10b981; color:white; border:none; border-radius:50px; font-weight:bold; cursor:pointer; box-shadow:0 10px 30px rgba(16,185,129,0.4); font-size:18px; border:3px solid #fff;';
        btn.onclick = () => {
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
        document.body.appendChild(btn); return;
    }

    function getWeight(s) {
        if (!s) return { type: 0, val: 0 };
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
        if (!Array.isArray(newItems)) return;
        newItems.forEach(item => {
            currentData.push({ merchant: item.merchant, reward: item.reward, exclusions: item.exclusions, link: item.link, source: type });
            counts[type]++;
        });
        updateStatus();
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
                : `<button class="act" data-h="${best.link}">🚀 Go</button>`;

            tr.innerHTML = `<td style="width:180px"><strong>${best.merchant}</strong> ${g.items.length > 1 ? `<button class="tgl" data-t="${gid}">▶ ${g.items.length-1}</button>` : ''}</td><td style="color:#15803d; font-weight:bold; width:120px;">${best.reward}</td><td style="width:80px">${actionCell}</td><td style="color:#64748b; font-size:11px;">${best.exclusions || 'None'}</td>`;
            tbody.appendChild(tr);

            if(g.items.length > 1) {
                g.items.slice(1).forEach(c => {
                    const ctr = document.createElement('tr');
                    ctr.className = `child ${gid}`;
                    ctr.style.display = 'none';
                    ctr.style.backgroundColor = '#f8fafc';
                    const childAction = (c.source === 'miles')
                        ? `<small style="color:#94a3b8;">✈️ Miles</small>`
                        : `<button class="act" data-h="${c.link}">🚀</button>`;
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
                const res = await fetch('https://capitaloneshopping.com/api/v1/feed', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ "contentProps": {"pagination": {"limit": 100, ...(webToken?{"nextPageToken":webToken}:{})}}, "context": {"location": {"state": conf.state, "zipcode": conf.zip}}})
                });
                const d = await res.json();
                if (!d.items) break;
                pushDataBatch(d.items.map(i => ({
                    merchant: i.merchantName || i.merchantDisplayText || 'Unknown',
                    reward: i.stats.cashbackV2 || '',
                    exclusions: i.stats.exclusionsText || 'None',
                    link: i.href || '',
                    source: 'web'
                })), 'web');
                webToken = d.pagination?.nextPageToken;
                pages++; if (!webToken) break;
            } catch(e) { break; }
        }
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

    const host = document.createElement('div');
    host.style.cssText = 'position: fixed; top: 20px; left: 20px; z-index: 2147483647;';
    document.body.appendChild(host);
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
                <button class="btn-all" id="btn-all">🚀 Start All-Fetch</button>
                <div class="btn-group" id="btn-group-box"><button class="btn-sm" id="btn-web">🌐 Web</button><button class="btn-sm" id="btn-mail">📧 Email</button><button class="btn-sm" id="btn-miles">✈️ Miles</button></div>
                <div id="status-bar" style="font-size:11px;color:#bae6fd;text-align:center;font-family:monospace;background:rgba(0,0,0,0.2);padding:4px;border-radius:4px;">Ready.</div>
                <button id="stg-btn" style="background:transparent;border:1px solid #fff;color:#fff;font-size:10px;cursor:pointer;width:100%;">⚙️ Settings</button>
            </div>
            <div id="stg-panel" style="display:none;padding:12px;background:#f8fafc;border-bottom:1px solid #ddd;">
                <div class="set-row"><strong>GAS URL:</strong> <input id="in-url" style="flex:1;"/></div>
                <div class="set-row"><strong>State:</strong> <input id="in-state" style="width:30px;"/> <strong>Zip:</strong> <input id="in-zip" style="width:50px;"/> <strong>CPP:</strong> <input id="in-val" style="width:40px;"/></div>
                <div class="set-row"><input type="checkbox" id="in-miles-dis"/> <label for="in-miles-dis"><strong>Disable Miles Module</strong></label></div>
                <button id="save-btn" class="btn-all" style="padding:6px 10px; width:100%; background:#004d73; margin-top:5px;">Save Settings</button>
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
    shadow.getElementById('btn-toggle').onclick = (e) => { e.stopPropagation(); toggleExpand(); };
    shadow.getElementById('btn-all').onclick = (e) => { e.stopPropagation(); toggleExpand(true); fetchWeb(); fetchEmail(); if(!getConfig().milesDisabled) fetchMilesDirect(); };
    shadow.getElementById('btn-web').onclick = (e) => { e.stopPropagation(); toggleExpand(true); fetchWeb(); };
    shadow.getElementById('btn-mail').onclick = (e) => { e.stopPropagation(); toggleExpand(true); fetchEmail(); };
    shadow.getElementById('btn-miles').onclick = (e) => { e.stopPropagation(); toggleExpand(true); fetchMilesDirect(); };
    shadow.getElementById('stg-btn').onclick = (e) => { e.stopPropagation(); const p = shadow.getElementById('stg-panel'); p.style.display = p.style.display === 'none' ? 'block' : 'none'; };
    shadow.getElementById('save-btn').onclick = () => {
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
            let targetUrl = actBtn.dataset.h;
            if (targetUrl) {
                if (!targetUrl.startsWith('http')) {
                    targetUrl = "https://capitaloneshopping.com" + (targetUrl.startsWith('/') ? '' : '/') + targetUrl;
                }
                window.open(targetUrl.replace('__WBCLICKID__', generateUUID()), '_blank');
            }
        }
        if (e.target.classList.contains('tgl')) {
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
})();
