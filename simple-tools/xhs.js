(function () {
  'use strict';

  const CONFIG = {
    // 详情接口地址 (根据实际情况可调整)
    detailApi: 'https://edith.xiaohongshu.com/api/sns/web/v1/note',
    // 列表接口地址
    listApi: 'https://edith.xiaohongshu.com/api/sns/web/v1/user_posted',
    // 请求并发数 (为了稳定，建议1，可自行调大)
    concurrency: 1,
    // 获取详情重试次数
    retryTimes: 1,
    // 重试延迟基础(ms)
    retryDelay: 2000,
    // 请求间隔(ms) (避免频率过高)
    requestInterval: 1000,
  };

  // ---------- 工具函数 ----------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // 解析URL参数
  function getUrlParams() {
    const params = new URLSearchParams(window.location.search);
    return {
      xsec_token: params.get('xsec_token') || '',
      xsec_source: params.get('xsec_source') || '',
    };
  }

  // 从路径中提取user_id
  function getUserIdFromPath() {
    const match = window.location.pathname.match(/\/user\/profile\/([^/?]+)/);
    return match ? match[1] : null;
  }

  // 获取初始化数据 (从window.__INITIAL_STATE__)
  function getInitialData() {
    if (!window.__INITIAL_STATE__ || !window.__INITIAL_STATE__.user) {
      throw new Error('未找到 __INITIAL_STATE__，请确保在博主主页运行');
    }
    const state = window.__INITIAL_STATE__.user;
    // 笔记列表 (第一页)
    let firstPageNotes = [];
    if (state.notes && Array.isArray(state.notes._rawValue)) {
      firstPageNotes = state.notes._rawValue?.[0] ?? [];
    } else {
      console.warn('未能从 __INITIAL_STATE__ 解析笔记列表，尝试从接口重新获取');
    }

    // 游标 cursor
    let cursor = '';
    if (state.noteQueries && Array.isArray(state.noteQueries._rawValue) && state.noteQueries._rawValue[0]) {
      cursor = state.noteQueries._rawValue[0].cursor || '';
    } else {
      console.error('first page no cursor !!!');
    }

    return { firstPageNotes, cursor };
  }

  // ---------- 缓存管理 ----------
  function getCacheKey(userId) {
    return `XHS_NOTES_${userId}`;
  }

  // 加载缓存 { note_id: { detail, fetchTime }, ... }
  function loadCache(userId) {
    const key = getCacheKey(userId);
    if (window[key]) return window[key];

    try {
      const cached = localStorage.getItem(key);
      window[key] = cached ? JSON.parse(cached) : {};
      return window[key];
    } catch (e) {
      console.warn('读取缓存失败', e);
      window[key] = {};
      return window[key];
    }
  }

  // 保存单条笔记到缓存
  function saveNoteToCache(userId, noteId, detailData) {
    const key = getCacheKey(userId);
    const cache = loadCache(userId);
    cache[noteId] = {
      detail: detailData,
      fetchTime: Date.now(),
    };
    try {
      localStorage.setItem(key, JSON.stringify(cache));
    } catch (e) {
      console.error('保存到localStorage失败，可能超出容量', e);
      // 可以提示用户，但继续
    }
  }

  // 检查笔记是否已获取
  function isNoteFetched(userId, noteId) {
    const cache = loadCache(userId);
    return !!cache[noteId];
  }

  // ---------- 网络请求 ----------
  async function fetchWithRetry(url, options, retries = CONFIG.retryTimes) {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, options);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        if (data.code === 0 || data.success === true) {
          return data;
        } else {
          throw new Error(`接口错误: ${data.msg || data.message || '未知错误'}`);
        }
      } catch (err) {
        console.warn(`请求失败 (${i + 1}/${retries}): ${url}`, err.message);
        if (i === retries - 1) throw err;
        await sleep(CONFIG.retryDelay * Math.pow(2, i)); // 指数退避
      }
    }
  }

  // 获取一页列表
  async function fetchListPage(userId, cursor, xsec_token, xsec_source) {
    const url = new URL(CONFIG.listApi);
    url.searchParams.set('num', '30');
    url.searchParams.set('cursor', cursor);
    url.searchParams.set('user_id', userId);
    url.searchParams.set('image_formats', 'jpg,webp,avif');
    url.searchParams.set('xsec_token', xsec_token);
    url.searchParams.set('xsec_source', xsec_source);

    const data = await fetchWithRetry(url.toString(), {
      method: 'GET',
      credentials: 'include',
      headers: {
        accept: 'application/json, text/plain, */*',
      },
    });
    return data.data; // { notes, cursor, has_more }
  }

  // ---------- 核心处理 ----------
  async function processNotes(notes, userId, xsecTokenParam, xsecSourceParam) {
    for (const note of notes) {
      // 提取必要字段
      const noteId = note.note_id || note.id;
      if (!noteId) {
        console.warn('笔记缺少note_id，跳过', note);
        continue;
      }

      // 检查缓存
      if (isNoteFetched(userId, noteId)) {
        console.log(`⏭️ 笔记 ${noteId} 已存在缓存，跳过`);
        continue;
      }

      // 获取详情（使用笔记自带的xsec_token，可能没有）
      const noteXsecToken = note.xsec_token || '';
      console.log(`🔍 正在获取: ${noteId} - ${note.display_title || note.title || ''}`);

      let detail = null;
      try {
        detail = await fetchNoteDetail(noteId, noteXsecToken);
      } catch (err) {
        console.error(`❌ 笔记 ${noteId} 获取失败，已跳过`, err);
        // 失败不保存，继续下一个
        continue;
      }

      if (detail) {
        // 保存到缓存
        saveNoteToCache(userId, noteId, detail);
        console.log(`✅ 已保存: ${noteId}`);
      }

      // 控制请求间隔
      await sleep(CONFIG.requestInterval);
    }
  }

  async function main() {
    console.log('🚀 开始小红书博主笔记批量获取脚本');

    // 1. 获取基础信息
    const userId = getUserIdFromPath();
    if (!userId) {
      console.error('❌ 无法从URL提取user_id，请检查页面');
      return;
    }
    const { xsec_token, xsec_source } = getUrlParams();
    if (!xsec_token || !xsec_source) {
      console.warn('⚠️ URL中缺少xsec_token或xsec_source，后续列表请求可能失败');
    }

    // console.log('userId', userId);
    // console.log('xsec_source', xsec_source);
    // console.log('xsec_token', xsec_token);

    // 2. 从初始化数据获取第一页和起始cursor
    let { firstPageNotes, cursor } = getInitialData();
    console.log(`📄 第一页笔记数: ${firstPageNotes.length}, 起始cursor: ${cursor}`);

    // console.log('firstPageNotes', firstPageNotes);

    // 如果第一页为空，尝试直接调用接口获取第一页 (cursor传空串)
    // if (firstPageNotes.length === 0) {
    //   console.log('初始列表为空，尝试从接口获取第一页');
    //   try {
    //     const firstPage = await fetchListPage(userId, '', xsec_token, xsec_source);
    //     if (firstPage && firstPage.notes) {
    //       firstPageNotes = firstPage.notes;
    //       cursor = firstPage.cursor;
    //     }
    //   } catch (e) {
    //     console.error('获取第一页接口失败', e);
    //     return;
    //   }
    // }

    // // 3. 加载缓存统计
    const cache = loadCache(userId);
    const fetchedCount = Object.keys(cache).length;
    console.log(`📦 本地缓存已有 ${fetchedCount} 条笔记`);

    // // 4. 按时间顺序处理：先处理第一页（最新），再循环翻页（更旧）
    const allNotes = [...firstPageNotes];
    let currentPageNotes = firstPageNotes;
    let currentCursor = cursor;
    let pageNum = 1;
    let hasMore = true;

    while (hasMore) {
      console.log(`\n📑 处理第 ${pageNum} 页，笔记数: ${currentPageNotes.length}, cursor: ${currentCursor}`);

      // 处理当前页笔记 (注意: 列表本身是按时间倒序，直接顺序处理即从新到旧)
      // TODO
      // await processNotes(currentPageNotes, userId, xsec_token, xsec_source);

      // 记录已完成的 cursor
      window.lastCursor = currentCursor;

      // 请求下一页
      try {
        const nextData = await fetchListPage(userId, currentCursor, xsec_token, xsec_source);
        if (nextData && nextData.notes && nextData.notes.length > 0) {
          currentPageNotes = nextData.notes;
          currentCursor = nextData.cursor;
          hasMore = nextData.has_more;
          pageNum++;

          allNotes.concat(currentPageNotes);
        } else {
          hasMore = false;
        }
      } catch (err) {
        console.error('❌ 翻页请求失败，终止流程', err);
        hasMore = false;
      }

      // 翻页间隔
      await sleep(CONFIG.requestInterval);
      console.log('allNotes', allNotes);
      break;
    }

    // // 5. 完成统计
    // const newCache = loadCache(userId);
    // const newFetched = Object.keys(newCache).length;
    // console.log(`\n🎉 全部处理完成！共获取到 ${newFetched} 条笔记 (新增 ${newFetched - fetchedCount} 条)`);
    // console.log('💾 数据已保存在 localStorage 中，键名为:', getCacheKey(userId));
  }

  window.addEventListener('load', main);
})();
