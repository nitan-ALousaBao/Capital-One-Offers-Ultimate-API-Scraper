// ==UserScript==
// @name         Capital One Offers Scraper (v7.6 High-Performance)
// @namespace    http://tampermonkey.net/
// @version      7.6
// @description  性能优化：增加Limit减少RTT、批处理渲染、去中心化配置
// @author       You
// @match        https://capitaloneshopping.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==

(function() {
    'use strict';

    const API_ENDPOINT = 'https://capitaloneshopping.com/api/v1/feed';
    const ITEMS_PER_PAGE = 100; // 🚀 优化：增加单页容量，大幅减少请求次数
    const MAX_PAGES = 30;       // 🚀 优化：30页*100条=3000条，足够覆盖全量

    let currentData = [];
    const seenKeys = new Set();

    const getConfig = () => ({
        url: GM_getValue('c1_api_url', ''),
        state: GM_getValue('c1_state', 'NY'),
        zip: GM_getValue('c1_zip', '10001')
    });

    // ==========================================
    // 📊 性能优化工具
    // ==========================================
    function getRewardWeight(rewardStr) {
        const numMatch = rewardStr.match(/(\d+(\.\d+)?)/);
        const val = numMatch ? parseFloat(numMatch[1]) : 0;
        if (rewardStr.includes('%')) return { type: 2, val };
        if (rewardStr.includes('$')) return { type: 1, val };
        return { type: 0, val };
    }

    function generateUUID() {
        return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    function createRow(item) {
        const tr = document.createElement('tr');
        if (item.reward.includes('💌')) tr.classList.add('email-offer');
        const actionHtml = item.link ? `<button class="activate-btn" data-href="${item.link}">🚀 Activate</button>` : `N/A`;
        tr.innerHTML = `<td><strong>${item.merchant}</strong></td><td class="reward-cell">${item.reward}</td><td>${actionHtml}</td><td class="exclusions-cell">${item.exclusions}</td>`;
        return tr;
    }

    // 🚀 优化：批量渲染，减少 DOM 回流
    function refreshDisplay() {
        const filterVal = shadow.getElementById('filter-source').value;
        const sortVal = shadow.getElementById('sort-by').value;
        const searchVal = shadow.getElementById('search-input').value.toLowerCase().trim();

        let displayData = [...currentData];
        if (searchVal) displayData = displayData.filter(i => i.merchant.toLowerCase().includes(searchVal));
        if (filterVal === 'email') displayData = displayData.filter(i => i.reward.includes('💌'));
        else if (filterVal === 'web') displayData = displayData.filter(i => !i.reward.includes('💌'));

        displayData.sort((a, b) => {
            if (sortVal === 'name') return a.merchant.localeCompare(b.merchant);
            if (sortVal === 'reward') {
                const wA = getRewardWeight(a.reward), wB = getRewardWeight(b.reward);
                return (wA.type !== wB.type) ? (wB.type - wA.type) : (wB.val - wA.val);
            }
            return (a.exclusions || "").localeCompare(b.exclusions || "");
        });

        const tbody = shadow.getElementById('table-body');
        const fragment = document.createDocumentFragment(); // 内存中构建
        displayData.forEach(item => fragment.appendChild(createRow(item)));
        tbody.innerHTML = '';
        tbody.appendChild(fragment); // 一次性更新
    }

    async function startTurboFetch(statusCallback) {
        const config = getConfig();
        if (!config.url) { statusCallback("❌ 需配置 API URL"); return; }
        currentData = []; seenKeys.clear();

        // 1. Gmail 抓取 (并行)
        GM_xmlhttpRequest({
            method: "GET", url: config.url,
            onload: (res) => {
                try {
                    const data = JSON.parse(res.responseText);
                    (data.items || []).forEach(o => {
                        const key = `${o.merchant.toLowerCase()}|${o.reward}`;
                        if (!seenKeys.has(key)) { seenKeys.add(key); currentData.push(o); }
                    });
                    refreshDisplay();
                    statusCallback(`✅ 邮件处理完成`);
                } catch(e) {}
            }
        });

        // 2. Web 抓取 (大批次请求)
        let currentToken = null, pageCount = 0;
        while (pageCount < MAX_PAGES) {
            const payload = {
                "contentProps": { "pagination": { "limit": ITEMS_PER_PAGE, ...(currentToken ? { "nextPageToken": currentToken } : {}) } },
                "context": {
                    "device": { "memory": "8", "concurrency": "8" },
                    "location": { "state": config.state, "zipcode": config.zip },
                    "page": { "path": window.location.pathname, "url": window.location.href, "title": document.title },
                    "userAgent": navigator.userAgent
                }
            };
            try {
                const res = await fetch(API_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                if (res.status === 429) { statusCallback("⚠️ 触发风控，休息 5s..."); await new Promise(r => setTimeout(r, 5000)); continue; }
                const data = await res.json();
                const items = data?.items || [];
                if (items.length === 0) break;

                items.forEach(item => {
                    const o = { merchant: item.merchantName || 'Unknown', reward: item.stats?.cashbackV2 || item.stats?.cashback || '', exclusions: item.stats?.exclusionsText || 'None', link: item.href || '' };
                    const key = `${o.merchant.toLowerCase()}|${o.reward}`;
                    if (!seenKeys.has(key)) { seenKeys.add(key); currentData.push(o); }
                });

                refreshDisplay(); // 每一页更新一次
                pageCount++;
                statusCallback(`⚡ 已加载: ${currentData.length} 条... (批次 ${pageCount})`);
                currentToken = data?.pagination?.nextPageToken;
                if (!currentToken) break;
            } catch (e) { break; }
            await new Promise(r => setTimeout(r, 100)); // 给主线程喘息时间
        }
        statusCallback(`🎉 完成! 共聚合 ${currentData.length} 条数据`);
    }

    // ==========================================
    // 🎨 UI 注入 (Shadow DOM)
    // ==========================================
    const host = document.createElement('div');
    host.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 2147483647;';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
        :host { font-family: -apple-system, system-ui, sans-serif; }
        #scraper-container { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 15px 35px rgba(0,0,0,0.2); width: 280px; transition: all 0.3s ease; overflow: hidden; display: flex; flex-direction: column; }
        #scraper-container.expanded { width: 950px; max-height: 85vh; }
        .header { background: #004d73; color: white; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
        .header-btn { background: #f60859; color: white; padding: 10px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 700; border: none; }
        .content { display: none; flex-direction: column; overflow: hidden; }
        #scraper-container.expanded .content { display: flex; height: calc(85vh - 130px); }
        .toolbar { padding: 10px 16px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; display: flex; flex-wrap: wrap; gap: 8px; }
        input, select { padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; outline: none; }
        .table-container { overflow-y: auto; flex: 1; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
        th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid #f1f5f9; word-break: break-word; }
        th { background: #f8fafc; position: sticky; top: 0; z-index: 10; font-weight: 600; }
        tr.email-offer { background-color: #fff7ed; border-left: 4px solid #f60859; }
        .reward-cell { color: #15803d; font-weight: 700; }
        .activate-btn { padding: 6px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; cursor: pointer; border: none; background: #0276b1; color: white; }
        .settings-panel { padding: 15px; background: #f1f5f9; border-top: 1px solid #e2e8f0; display: none; flex-direction: column; gap: 10px; }
        .settings-panel.active { display: flex; }
    `;
    shadow.appendChild(style);

    const container = document.createElement('div');
    container.id = 'scraper-container';
    container.innerHTML = `
        <div class="header">
            <button class="header-btn" id="btn-api-fetch">⚡ Start Turbo Fetch</button>
            <div style="display:flex; gap:5px;">
                <button class="header-btn" id="btn-toggle" style="flex:1; background:#0276b1; display:none;">▼ Panel</button>
                <button class="header-btn" id="btn-settings" style="background:#475569">⚙️ Settings</button>
            </div>
            <div id="live-status" style="font-size:11px; text-align:center; color:#bae6fd;">Ready.</div>
        </div>
        <div class="settings-panel" id="settings-ui">
            <input type="text" id="set-url" placeholder="Apps Script URL" />
            <div style="display:flex; gap:5px;">
                <input type="text" id="set-state" placeholder="State" style="width:80px;"/>
                <input type="text" id="set-zip" placeholder="Zip" style="flex:1;"/>
            </div>
            <button class="header-btn" id="btn-save-settings">Save & Close</button>
        </div>
        <div class="content">
            <div class="toolbar">
                <input type="text" id="search-input" placeholder="Search..." style="flex:1;" />
                <select id="filter-source"><option value="all">All</option><option value="email">Email 💌</option><option value="web">Web</option></select>
                <select id="sort-by"><option value="reward">Size (% vs $)</option><option value="name">Name A-Z</option></select>
            </div>
            <div class="table-container"><table><thead><tr><th>Merchant</th><th>Reward</th><th>Action</th><th>Notes/Exp</th></tr></thead><tbody id="table-body"></tbody></table></div>
        </div>
    `;
    shadow.appendChild(container);

    // 绑定事件
    const settingsBtn = shadow.getElementById('btn-settings');
    const settingsUI = shadow.getElementById('settings-ui');
    settingsBtn.onclick = () => settingsUI.classList.toggle('active');

    shadow.getElementById('btn-save-settings').onclick = () => {
        GM_setValue('c1_api_url', shadow.getElementById('set-url').value.trim());
        GM_setValue('c1_state', shadow.getElementById('set-state').value.trim().toUpperCase());
        GM_setValue('c1_zip', shadow.getElementById('set-zip').value.trim());
        settingsUI.classList.remove('active');
    };

    const initialConfig = getConfig();
    shadow.getElementById('set-url').value = initialConfig.url;
    shadow.getElementById('set-state').value = initialConfig.state;
    shadow.getElementById('set-zip').value = initialConfig.zip;

    shadow.getElementById('filter-source').onchange = refreshDisplay;
    shadow.getElementById('sort-by').onchange = refreshDisplay;
    shadow.getElementById('search-input').oninput = refreshDisplay;

    shadow.getElementById('table-body').onclick = (e) => {
        if (e.target.classList.contains('activate-btn')) {
            window.open(e.target.dataset.href.replace('__WBCLICKID__', generateUUID()), '_blank');
        }
    };

    shadow.getElementById('btn-api-fetch').onclick = async () => {
        container.classList.add('expanded');
        await startTurboFetch((msg) => shadow.getElementById('live-status').innerText = msg);
        shadow.getElementById('btn-toggle').style.display = 'block';
    };
    shadow.getElementById('btn-toggle').onclick = () => container.classList.toggle('expanded');

})();
