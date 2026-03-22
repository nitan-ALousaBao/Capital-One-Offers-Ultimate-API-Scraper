// ==UserScript==
// @name         Capital One Offers Ultimate API Scraper
// @namespace    http://tampermonkey.net/
// @version      4.5
// @description  游标分页极速抓取，完美 UUID 激活，修复面板开关逻辑 (分离 Fetch 与 Toggle)
// @author       You
// @match        https://capitaloneshopping.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const API_ENDPOINT = 'https://capitaloneshopping.com/api/v1/feed';
    const LIMIT = 25;
    const MAX_PAGES = 200; 

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // ==========================================
    // 🛠️ 核心数据解析
    // ==========================================
    function parseResponseData(responseData) {
        const rawItems = responseData?.items || [];
        const nextToken = responseData?.pagination?.nextPageToken || null;

        const parsedItems = rawItems.map(item => {
            const stats = item.stats || {};
            return {
                merchant: item.merchantName || 'Unknown',
                reward: stats.cashbackV2 || stats.cashback || '',
                exclusions: stats.exclusionsText || 'None',
                link: item.href || '' 
            };
        });

        return { items: parsedItems, nextToken };
    }

    // ==========================================
    // 🚀 核心极速抓取引擎
    // ==========================================
    async function fetchAllOffersViaAPI(statusCallback) {
        let allOffers = [];
        let currentToken = null; 
        let pageCount = 0;
        let hasMore = true;

        statusCallback(`🚀 开始建立极速 API 连接...`);

        while (hasMore && pageCount < MAX_PAGES) {
            const payload = {
                "contentProps": {
                    "pagination": {
                        "limit": LIMIT,
                        ...(currentToken ? { "nextPageToken": currentToken } : {})
                    }
                },
                "context": {
                    "device": { "memory": "8", "concurrency": "8" },
                    "browser": { "name": "Chrome", "version": "146.0.0.0", "major": "146" },
                    "os": { "name": "Windows", "version": "10" },
                    "screen": { "width": 2560, "height": 1080, "density": 1 },
                    "locale": navigator.language || "en-US",
                    "country": "US",
                    "location": { "state": "NJ", "zipcode": "07302" },
                    "page": {
                        "path": window.location.pathname,
                        "url": window.location.href,
                        "referrer": document.referrer || "",
                        "search": window.location.search || "",
                        "title": document.title
                    },
                    "userAgent": navigator.userAgent
                }
            };

            let success = false;
            let retries = 0;
            let maxRetries = 3;

            pageCount++;

            while (!success && retries < maxRetries) {
                try {
                    statusCallback(`⚡ Fetching Page ${pageCount}...`);
                    
                    const response = await fetch(API_ENDPOINT, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': '*/*'
                        },
                        body: JSON.stringify(payload)
                    });

                    if (response.status === 429) {
                        retries++;
                        const backoffTime = 1000 * Math.pow(2, retries); 
                        statusCallback(`⚠️ 触发限频 (429), 退避等待 ${backoffTime}ms...`);
                        await sleep(backoffTime);
                        continue; 
                    }

                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    
                    const data = await response.json();
                    const { items, nextToken } = parseResponseData(data);
                    
                    if (items.length === 0) {
                        hasMore = false;
                        break;
                    }

                    allOffers = allOffers.concat(items);
                    statusCallback(`✅ Page ${pageCount} Done (${allOffers.length} deals)`);

                    if (nextToken) {
                        currentToken = nextToken;
                    } else {
                        hasMore = false;
                    }
                    
                    success = true;

                } catch (error) {
                    retries++;
                    if (retries >= maxRetries) {
                        statusCallback(`❌ Page ${pageCount} 彻底失败`);
                        hasMore = false;
                    } else {
                        await sleep(1500);
                    }
                }
            }
        }

        const seenKeys = new Set();
        const uniqueData = allOffers.filter(r => {
            if (r.merchant === 'Unknown' || r.reward === '') return false;
            const uniqueKey = `${r.merchant}|${r.reward}`;
            if (seenKeys.has(uniqueKey)) return false;
            seenKeys.add(uniqueKey);
            return true;
        }).sort((a, b) => a.merchant.localeCompare(b.merchant));

        statusCallback(`🎉 完成! 极速获取 ${uniqueData.length} 个去重 Offers.`);
        return uniqueData;
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
        :host { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        #scraper-container {
            background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.15); width: 220px; transition: all 0.3s ease;
            overflow: hidden; display: flex; flex-direction: column;
        }
        #scraper-container.expanded { width: 750px; max-height: 80vh; }
        .header { background: #004d73; color: white; padding: 10px; display: flex; flex-direction: column; gap: 8px; user-select: none; }
        .header-btn {
            background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); 
            color: white; padding: 8px; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 600; transition: background 0.2s;
        }
        .header-btn:hover { background: rgba(255,255,255,0.2); }
        .header-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        
        /* 针对不同按钮的特定颜色 */
        #btn-api-fetch { background: #f60859; border-color: #d5044b; }
        #btn-api-fetch:hover { background: #d5044b; }
        #btn-toggle { background: #0276b1; border-color: #005a87; }
        #btn-toggle:hover { background: #005a87; }
        
        #live-status { font-size: 11px; text-align: center; color: #bae6fd; font-family: monospace; }
        .content { display: none; flex-direction: column; overflow: hidden; }
        #scraper-container.expanded .content { display: flex; height: calc(80vh - 120px); }
        .toolbar { padding: 8px 16px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; display: flex; gap: 10px; align-items: center; }
        #search-input { flex: 1; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 13px; outline: none; }
        .tool-btn { padding: 6px 12px; background: #0276b1; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500; }
        .table-container { overflow-y: auto; flex: 1; padding: 0; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
        th, td { text-align: left; padding: 10px 16px; border-bottom: 1px solid #e2e8f0; word-wrap: break-word; }
        th { background: #f1f5f9; position: sticky; top: 0; font-weight: 600; color: #475569; }
        th:nth-child(1) { width: 25%; } th:nth-child(2) { width: 20%; } th:nth-child(3) { width: 15%; } th:nth-child(4) { width: 40%; } 
        tr:hover { background: #f8fafc; }
        .reward-cell { color: #15803d; font-weight: 600; }
        .exclusions-cell { font-size: 11px; color: #64748b; }
        .activate-btn {
            padding: 6px 12px; border-radius: 4px; font-size: 11px; font-weight: 600; cursor: pointer; border: none;
            background: #0276b1; color: white; width: 100%; transition: background 0.2s; text-align: center;
        }
        .activate-btn:hover { background: #005a87; }
        .activate-btn:disabled { background: #94a3b8; cursor: not-allowed; }
    `;
    shadow.appendChild(style);

    const container = document.createElement('div');
    container.id = 'scraper-container';
    
    // UI 结构更新：将 Fetch 和 Toggle 作为两个并排或独立的按钮
    container.innerHTML = `
        <div class="header">
            <button class="header-btn" id="btn-api-fetch">⚡ Refresh API Data</button>
            <button class="header-btn" id="btn-toggle" style="display:none;">▼ Show Panel</button>
            <div id="live-status">Ready.</div>
        </div>
        <div class="content">
            <div class="toolbar">
                <input type="text" id="search-input" placeholder="Filter by merchant name..." autocomplete="off" />
                <button class="tool-btn" id="copy-btn">Copy JSON</button>
            </div>
            <div class="table-container">
                <table>
                    <thead><tr><th>Merchant</th><th>Reward</th><th>Action</th><th>Exclusions</th></tr></thead>
                    <tbody id="table-body"></tbody>
                </table>
            </div>
        </div>
    `;
    shadow.appendChild(container);

    const btnApiFetch = shadow.getElementById('btn-api-fetch');
    const btnToggle = shadow.getElementById('btn-toggle');
    const liveStatus = shadow.getElementById('live-status');
    const tbody = shadow.getElementById('table-body');
    const searchInput = shadow.getElementById('search-input');
    const copyBtn = shadow.getElementById('copy-btn');

    let currentData = [];

    function renderTable(data) {
        tbody.innerHTML = '';
        data.forEach(item => {
            const tr = document.createElement('tr');
            const actionHtml = item.link 
                ? `<button class="activate-btn" data-href="${item.link}">🚀 Activate</button>`
                : `<button class="activate-btn" disabled>No Link</button>`;

            tr.innerHTML = `
                <td><strong>${item.merchant}</strong></td>
                <td class="reward-cell">${item.reward}</td>
                <td>${actionHtml}</td>
                <td class="exclusions-cell">${item.exclusions}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    // 动态注入合法 UUID 绕过拦截
    tbody.addEventListener('click', (e) => {
        if (e.target.classList.contains('activate-btn')) {
            let targetUrl = e.target.getAttribute('data-href');
            if (targetUrl) {
                const generateUUID = () => {
                    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
                    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
                        return v.toString(16);
                    });
                };
                const finalUrl = targetUrl.replace('__WBCLICKID__', generateUUID());
                window.open(finalUrl, '_blank');
            }
        }
    });

    // 抓取逻辑
    btnApiFetch.addEventListener('click', async () => {
        btnApiFetch.disabled = true;
        btnApiFetch.innerText = 'Fetching...';
        btnToggle.style.display = 'none'; // 抓取时隐藏 Toggle
        
        currentData = await fetchAllOffersViaAPI((msg) => { liveStatus.innerText = msg; });
        
        if (currentData.length > 0) {
            searchInput.value = '';
            renderTable(currentData);
            container.classList.add('expanded');
            btnToggle.style.display = 'block';
            btnToggle.innerText = '▲ Hide Panel';
        }
        
        btnApiFetch.disabled = false;
        btnApiFetch.innerText = '⚡ Refresh API Data';
    });

    // 独立的 Toggle 逻辑：不再丢弃数据
    btnToggle.addEventListener('click', () => {
        const isExpanded = container.classList.contains('expanded');
        if (isExpanded) {
            container.classList.remove('expanded');
            btnToggle.innerText = `▼ Show Panel (${currentData.length} Deals)`;
        } else {
            container.classList.add('expanded');
            btnToggle.innerText = '▲ Hide Panel';
        }
    });

    searchInput.addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase().trim();
        renderTable(currentData.filter(item => item.merchant.toLowerCase().includes(term)));
    });

    copyBtn.addEventListener('click', async () => {
        const term = searchInput.value.toLowerCase().trim();
        const dataToExport = (term ? currentData.filter(item => item.merchant.toLowerCase().includes(term)) : currentData)
            .map(({ link, ...rest }) => rest);
            
        if (dataToExport.length === 0) return;
        try {
            await navigator.clipboard.writeText(JSON.stringify(dataToExport, null, 2));
            const prevText = copyBtn.innerText;
            copyBtn.innerText = '✅ Copied!';
            setTimeout(() => copyBtn.innerText = prevText, 2000);
        } catch (err) {}
    });

})();
