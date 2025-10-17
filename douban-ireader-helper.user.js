// ==UserScript==
// @name         豆瓣读书 - 掌阅书城搜索助手
// @namespace    douban-ireader-helper
// @version      1.6.0
// @description  在豆瓣读书页面显示掌阅书城的搜索结果，支持列表页和详情页
// @author       Wang Dongguan
// @match        https://book.douban.com/mine*
// @match        https://book.douban.com/people/*/wish*
// @match        https://book.douban.com/subject/*
// @grant        GM_xmlhttpRequest
// @connect      m.zhangyue.com
// @license      MIT
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  // ========== 配置常量 ==========
  const CACHE_KEY_PREFIX = "ireader_cache_";
  const CACHE_VERSION = "v6"; // 缓存版本（增加作者匹配逻辑）
  const CACHE_VERSION_KEY = "ireader_cache_version";
  const CACHE_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7天过期
  const API_TIMEOUT = 10000; // 10秒超时
  const BATCH_SIZE = 3; // 并发批次大小
  const DEBUG = false; // 调试模式（生产环境设为false）

  // ========== 工具函数 ==========

  // 全局DOMParser实例（复用，避免重复创建）
  const domParser = new DOMParser();

  // 调试日志（仅在DEBUG模式下输出）
  function debugLog(...args) {
    if (DEBUG) console.log("[掌阅助手]", ...args);
  }

  // 注入CSS样式（替代JS事件监听器）
  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      /* 列表页链接hover效果 */
      .ireader-link.success:hover {
        background-color: #37a !important;
        color: #fff !important;
      }
      .ireader-link.success:hover .checkmark {
        color: #fff !important;
      }

      /* 详情页链接hover效果 */
      .ireader-detail-link:hover {
        background-color: #37a !important;
        color: #fff !important;
      }
    `;
    document.head.appendChild(style);
  }

  // 更新列表页UI（原地更新，不删除重建）
  function updateListItemUI(bookElement, result, status) {
    const linkSpan = bookElement.querySelector(".ireader-info");
    if (!linkSpan) {
      // 首次创建
      insertListItemUI(bookElement, result, status);
      return;
    }

    // 原地更新：只修改link的内容和属性
    const link = linkSpan.querySelector(".ireader-link");
    if (!link) return;

    // 重置状态类
    link.className = "ireader-link";

    // 根据状态更新内容
    if (status === "loading") {
      link.textContent = "查询掌阅书城中...";
      link.style.color = "#666";
      link.style.cursor = "default";
      link.removeAttribute("href");
      link.removeAttribute("target");
    } else if (status === "error") {
      link.innerHTML = `请求失败 <span class="ireader-retry" style="text-decoration: underline; cursor: pointer; color: #37a;">重试</span>`;
      link.style.color = "#cc0000";
      link.style.cursor = "default";
      link.removeAttribute("href");
      link.removeAttribute("target");
    } else if (result && result.found) {
      link.className = "ireader-link success";
      link.href = result.url;
      link.target = "_blank";
      link.innerHTML = '<span class="checkmark" style="color: #0b7c2a;">✓</span> 掌阅书城有书';
      link.style.color = "#37a";
      link.style.cursor = "pointer";
    } else {
      link.innerHTML = '<span style="color: #999;">✗</span> 掌阅书城没有';
      link.style.color = "#999";
      link.style.cursor = "default";
      link.removeAttribute("href");
      link.removeAttribute("target");
    }
  }

  // 更新详情页UI（原地更新，不删除重建）
  function updateDetailPageUI(result, status) {
    // 查找现有卡片
    const aside = document.querySelector(".aside");
    if (!aside) return;

    let card = aside.querySelector(".ireader-card");
    if (!card) {
      // 首次创建
      insertDetailPageUI(result, status);
      return;
    }

    // 原地更新：只修改内容区域
    const content = card.querySelector(".ireader-content");
    if (!content) return;

    if (status === "loading") {
      content.textContent = "查询中...";
      content.style.color = "#666";
    } else if (status === "error") {
      content.innerHTML = `
        <span style="color: #cc0000;">请求失败</span>
        <a href="#" class="ireader-retry" style="margin-left: 8px; color: #37a;">重试</a>
      `;
    } else if (result && result.found) {
      content.innerHTML = `
        <span style="color: #0b7c2a;">✓ 有此书</span>
        <a href="${result.url}" target="_blank" class="ireader-detail-link"
           style="float: right; color: #37a; text-decoration: none;">
          去看看
        </a>
      `;
    } else {
      content.innerHTML = `<span style="color: #999;">✗ 暂无此书</span>`;
    }
  }

  // ========== 1. 页面类型识别 ==========
  function getPageType() {
    const url = window.location.href;
    if (url.includes("/subject/")) return "detail"; // 详情页
    if (url.includes("/wish") || url.includes("status=wish")) return "list"; // 列表页
    return null;
  }

  // ========== 2. 书名提取 ==========

  // 列表页 - 提取所有书籍
  function getBooksFromList() {
    const books = [];
    const bookItems = document.querySelectorAll("li.subject-item");

    bookItems.forEach((item) => {
      const titleElement = item.querySelector(".info h2 a");
      if (titleElement) {
        // 只取主标题（冒号前的部分），去除副标题
        const fullTitle = titleElement.textContent.trim();
        const mainTitle = fullTitle.split(/[：:]/)[0].trim(); // 支持中英文冒号

        books.push({
          title: mainTitle,
          element: item, // 保存元素引用，用于后续插入UI
        });
      }
    });

    return books;
  }

  // 详情页 - 提取当前书籍
  function getBookFromDetail() {
    const titleElement = document.querySelector('[property="v:itemreviewed"]');
    return titleElement ? titleElement.textContent.trim() : null;
  }

  // ========== 3. 掌阅API搜索模块 ==========

  // API调用
  function searchIReader(bookTitle) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: `https://m.zhangyue.com/search/more?keyWord=${encodeURIComponent(bookTitle)}`,
        timeout: API_TIMEOUT,
        onload: function (response) {
          if (response.status === 200) {
            resolve(response.responseText);
          } else {
            reject(new Error(`API请求失败: ${response.status}`));
          }
        },
        onerror: function (error) {
          reject(error);
        },
        ontimeout: function () {
          reject(new Error("请求超时"));
        },
      });
    });
  }

  // 结果解析与书名匹配
  function parseSearchResult(responseText, originalTitle) {
    let htmlContent = responseText;

    // 掌阅API返回格式：{"html": "转义的HTML字符串"}
    try {
      const jsonData = JSON.parse(responseText);

      // 确认的字段名（已实测）：只有一个 html 字段
      if (typeof jsonData.html === "string") {
        htmlContent = jsonData.html; // JSON.parse已自动处理 \"、\/ 等转义
      } else {
        console.warn("掌阅API返回格式异常，缺少html字段:", jsonData);
        return { found: false };
      }
    } catch (e) {
      // JSON解析失败，可能是直接返回的HTML（罕见情况）
      console.warn("掌阅API返回非JSON格式，尝试直接解析HTML");
      // 不做任何处理，直接用 responseText
    }

    // 使用全局DOMParser实例（性能优化）
    const doc = domParser.parseFromString(htmlContent, "text/html");

    // 提取所有书籍链接
    const bookLinks = doc.querySelectorAll('a[href*="/detail/"]');

    if (bookLinks.length === 0) {
      return { found: false };
    }

    // 性能优化：提前计算豆瓣书名的清理结果（移出循环）
    const cleanedOriginalTitle = originalTitle
      .replace(/[（(].*?[）)]/g, "") // 去除括号及其内容
      .split(/[：:]/)[0] // 只取冒号前的主标题
      .trim();

    // 策略：只做精确匹配（去除冗余信息后）
    for (let link of bookLinks) {
      const nameElement = link.querySelector(".name");
      if (!nameElement) continue;

      const bookName = nameElement.textContent.trim();

      // 清理书名：去除冗余信息，只保留核心主标题
      const cleanedBookName = bookName
        .replace(/\[精品\]|\[.*?\]/g, "") // 去除[精品]等标签
        .replace(/[（(].*?[）)]/g, "") // 去除括号及其内容（版本信息等）
        .split(/[：:]/)[0] // 只取冒号前的主标题（去除副标题）
        .trim();

      // 精确匹配（去除冗余信息后）
      if (cleanedBookName === cleanedOriginalTitle) {
        return {
          found: true,
          url: link.href,
          title: bookName,
        };
      }
    }

    // 如果没有匹配，返回未找到（避免误匹配）
    return { found: false };
  }

  // ========== 4. UI插入模块 ==========

  // 列表页UI插入
  function insertListItemUI(bookElement, result, status) {
    // 查找 .cart-actions 区域（价格所在的容器）
    const cartActions = bookElement.querySelector(".info .ft .cart-actions");
    if (!cartActions) return;

    // 删除「加入购书单」按钮
    const cartInfo = cartActions.querySelector(".cart-info");
    if (cartInfo) cartInfo.remove();

    // 删除「去看电子版」按钮
    const ftElement = bookElement.querySelector(".info .ft");
    if (ftElement) {
      const ebookLink = ftElement.querySelector(".ebook-link");
      if (ebookLink) ebookLink.remove();
    }

    // 创建链接容器（模仿 .buy-info 的结构）
    const linkSpan = document.createElement("span");
    linkSpan.className = "ireader-info";
    linkSpan.style.cssText = "margin-left: 15px;";

    const link = document.createElement("a");
    link.className = "ireader-link";
    link.style.cssText = `
      color: #37a;
      font-size: 13px;
      text-decoration: none;
    `;

    // 根据状态显示不同内容
    if (status === "loading") {
      link.textContent = "查询掌阅书城中...";
      link.style.color = "#666";
      link.style.cursor = "default";
    } else if (status === "error") {
      link.innerHTML = `请求失败 <span class="ireader-retry" style="text-decoration: underline; cursor: pointer; color: #37a;">重试</span>`;
      link.style.color = "#cc0000";
    } else if (result && result.found) {
      link.className = "ireader-link success"; // 添加success类，用于CSS hover
      link.href = result.url;
      link.target = "_blank";
      link.innerHTML = '<span class="checkmark" style="color: #0b7c2a;">✓</span> 掌阅书城有书';
      // 移除JS事件监听器，改用CSS hover（性能优化）
    } else {
      link.innerHTML = '<span style="color: #999;">✗</span> 掌阅书城没有';
      link.style.color = "#999";
      link.style.cursor = "default";
    }

    linkSpan.appendChild(link);
    // 插入到 .cart-actions 内部（与价格在同一行）
    cartActions.appendChild(linkSpan);
  }

  // 详情页UI插入（模仿豆瓣「当前版本有售」卡片样式）
  function insertDetailPageUI(result, status) {
    // 查找右侧栏
    const aside = document.querySelector(".aside");
    if (!aside) return;

    // 创建卡片容器（使用豆瓣原生的 gray_ad 样式）
    const card = document.createElement("div");
    card.className = "gray_ad ireader-card"; // 添加ireader-card类，方便后续查找
    card.style.cssText = `
      padding: 18px 16px;
      margin-bottom: 20px;
      background: #f6f6f2;
    `;

    // 标题（使用豆瓣原生样式）
    const title = document.createElement("h2");
    title.style.cssText = `
      font-size: 15px;
      color: #0b7c2a;
      margin: 0 0 10px 0;
      font-weight: normal;
    `;
    title.innerHTML =
      "<span>掌阅书城</span>&nbsp;·&nbsp;·&nbsp;·&nbsp;·&nbsp;·&nbsp;·";
    card.appendChild(title);

    // 内容区域（单行布局）
    const content = document.createElement("div");
    content.className = "ireader-content"; // 添加类名，方便后续更新
    content.style.cssText = "font-size: 13px; line-height: 1.8;";

    if (status === "loading") {
      content.textContent = "查询中...";
      content.style.color = "#666";
    } else if (status === "error") {
      content.innerHTML = `
        <span style="color: #cc0000;">请求失败</span>
        <a href="#" class="ireader-retry" style="margin-left: 8px; color: #37a;">重试</a>
      `;
    } else if (result && result.found) {
      content.innerHTML = `
        <span style="color: #0b7c2a;">✓ 有此书</span>
        <a href="${result.url}" target="_blank" class="ireader-detail-link"
           style="float: right; color: #37a; text-decoration: none;">
          去看看
        </a>
      `;
    } else {
      content.innerHTML = `<span style="color: #999;">✗ 暂无此书</span>`;
    }

    card.appendChild(content);

    // 插入到 aside 的第一个位置（在广告之后）
    const firstElement = aside.querySelector("#dale_book_subject_top_right");
    if (firstElement && firstElement.nextSibling) {
      aside.insertBefore(card, firstElement.nextSibling);
    } else {
      aside.insertBefore(card, aside.firstChild);
    }

    // 移除JS事件监听器，改用CSS hover（性能优化）
  }

  // ========== 5. 缓存机制 ==========

  function getCachedResult(bookTitle) {
    const cacheKey = CACHE_KEY_PREFIX + bookTitle;
    const cached = localStorage.getItem(cacheKey);

    if (!cached) return null;

    try {
      const { result, timestamp } = JSON.parse(cached);
      // 检查是否过期
      if (Date.now() - timestamp > CACHE_EXPIRY) {
        localStorage.removeItem(cacheKey);
        return null;
      }
      return result;
    } catch (e) {
      // 缓存数据损坏，删除
      localStorage.removeItem(cacheKey);
      return null;
    }
  }

  function setCachedResult(bookTitle, result) {
    const cacheKey = CACHE_KEY_PREFIX + bookTitle;
    const cacheData = {
      result: result,
      timestamp: Date.now(),
    };
    try {
      localStorage.setItem(cacheKey, JSON.stringify(cacheData));
    } catch (e) {
      // localStorage已满，清理过期缓存
      cleanExpiredCache();
      try {
        localStorage.setItem(cacheKey, JSON.stringify(cacheData));
      } catch (e) {
        console.warn("缓存写入失败:", e);
      }
    }
  }

  // 清理过期缓存（修复：添加空值检查）
  function cleanExpiredCache() {
    const now = Date.now();
    const keysToRemove = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(CACHE_KEY_PREFIX)) {
        try {
          const cachedStr = localStorage.getItem(key);
          if (!cachedStr) {
            keysToRemove.push(key);
            continue;
          }
          const cached = JSON.parse(cachedStr);
          if (
            !cached ||
            !cached.timestamp ||
            now - cached.timestamp > CACHE_EXPIRY
          ) {
            keysToRemove.push(key);
          }
        } catch (e) {
          keysToRemove.push(key);
        }
      }
    }

    keysToRemove.forEach((key) => localStorage.removeItem(key));
  }

  // ========== 6. 重试机制 ==========

  function attachRetryHandler(element, bookTitle, callback) {
    const retryLink = element.querySelector(".ireader-retry");
    if (retryLink) {
      retryLink.addEventListener("click", (e) => {
        e.preventDefault();
        callback(bookTitle);
      });
    }
  }

  // ========== 7. 并发控制 ==========

  // 批量处理，控制并发数
  async function batchProcess(items, batchSize, processor) {
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await Promise.all(batch.map(processor));
    }
  }

  // ========== 8. 业务逻辑 ==========

  // 处理列表页（性能优化：只在无缓存时才显示loading）
  async function handleListPage() {
    const books = getBooksFromList();

    if (books.length === 0) {
      debugLog("未找到书籍条目");
      return;
    }

    debugLog(`找到 ${books.length} 本书，开始查询掌阅书城...`);

    // 性能优化：移除统一loading显示，改为按需显示

    // 分批并发处理（每批3个，避免速率限制）
    await batchProcess(books, BATCH_SIZE, async (book) => {
      // 检查缓存
      let result = getCachedResult(book.title);

      if (!result) {
        // 性能优化：只在无缓存时才显示loading
        updateListItemUI(book.element, null, "loading");

        try {
          const html = await searchIReader(book.title);
          result = parseSearchResult(html, book.title);
          setCachedResult(book.title, result);
        } catch (error) {
          console.error(`搜索 "${book.title}" 失败:`, error);

          // 显示错误状态
          updateListItemUI(book.element, null, "error");

          // 添加重试功能
          attachRetryHandler(book.element, book.title, async (title) => {
            updateListItemUI(book.element, null, "loading");

            try {
              const html = await searchIReader(title);
              const result = parseSearchResult(html, title);
              setCachedResult(title, result);
              updateListItemUI(book.element, result, "success");
            } catch (error) {
              updateListItemUI(book.element, null, "error");
            }
          });

          return; // 出错时直接返回
        }
      } else {
        debugLog(`"${book.title}" 使用缓存结果`);
      }

      // 更新UI显示结果（有缓存时直接显示，无缓存时从loading更新为结果）
      updateListItemUI(book.element, result, "success");
    });

    debugLog("所有书籍查询完成");
  }

  // 处理详情页
  async function handleDetailPage() {
    const bookTitle = getBookFromDetail();
    if (!bookTitle) {
      debugLog("未找到书名");
      return;
    }

    debugLog(`开始查询："${bookTitle}"`);

    // 显示加载状态
    insertDetailPageUI(null, "loading");

    // 检查缓存
    let result = getCachedResult(bookTitle);

    if (!result) {
      try {
        const html = await searchIReader(bookTitle);
        result = parseSearchResult(html, bookTitle);
        setCachedResult(bookTitle, result);
      } catch (error) {
        console.error("搜索失败:", error);

        // 显示错误状态
        updateDetailPageUI(null, "error");

        // 添加重试功能
        const aside = document.querySelector(".aside");
        if (aside) {
          attachRetryHandler(aside, bookTitle, async (title) => {
            updateDetailPageUI(null, "loading");

            try {
              const html = await searchIReader(title);
              const result = parseSearchResult(html, title);
              setCachedResult(title, result);
              updateDetailPageUI(result, "success");
            } catch (error) {
              updateDetailPageUI(null, "error");
            }
          });
        }

        return;
      }
    } else {
      debugLog("使用缓存结果");
    }

    // 更新UI显示结果
    updateDetailPageUI(result, "success");
  }

  // ========== 主执行流程 ==========

  function init() {
    // 注入CSS样式（替代JS事件监听器，性能优化）
    injectStyles();

    // 检查缓存版本，如果不匹配则清理所有旧缓存
    const currentVersion = localStorage.getItem(CACHE_VERSION_KEY);
    if (currentVersion !== CACHE_VERSION) {
      debugLog(
        `缓存版本更新：${currentVersion} -> ${CACHE_VERSION}，清理旧缓存`,
      );
      // 清理所有旧缓存
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(CACHE_KEY_PREFIX)) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((key) => localStorage.removeItem(key));
      // 更新版本号
      localStorage.setItem(CACHE_VERSION_KEY, CACHE_VERSION);
    }

    const pageType = getPageType();
    if (!pageType) return;

    if (pageType === "list") {
      handleListPage();
    } else if (pageType === "detail") {
      handleDetailPage();
    }
  }

  // 启动脚本
  init();
})();
