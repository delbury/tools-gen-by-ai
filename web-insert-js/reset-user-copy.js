// ==UserScript==
// @name         Reset Copy Event
// @namespace    https://github.com/delbury/tools-gen-by-ai
// @version      1.1.0
// @description  重置 user-select 样式以允许文本选中，并在捕获阶段拦截 copy 事件，阻止页面自定义处理器，恢复浏览器默认复制行为。
// @author       delbury
// @match        *://*/*
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  /**
   * 注入全局样式，用 !important 覆盖所有元素的 user-select 为浏览器默认值 auto。
   * 同时兼容带有厂商前缀的属性（-webkit-user-select）。
   */
  const css = `
    *, *::before, *::after {
      -webkit-user-select: auto !important;
      -moz-user-select: auto !important;
      -ms-user-select: auto !important;
      user-select: auto !important;
    }
  `;

  // 优先使用 GM_addStyle（@grant 已声明），保证在 document-start 时即生效
  if (typeof GM_addStyle === 'function') {
    GM_addStyle(css);
  } else {
    // 降级方案：手动创建 <style> 元素插入 <head>
    const applyStyle = () => {
      const style = document.createElement('style');
      style.id = 'tm-reset-user-select';
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', applyStyle, { once: true });
    } else {
      applyStyle();
    }
  }

  /**
   * 在捕获阶段监听 document 上的 copy 事件。
   * 调用 stopImmediatePropagation() 阻止后续所有（包括页面脚本注册的）copy 处理器执行，
   * 但不调用 preventDefault()，从而保留浏览器默认的复制行为。
   *
   * 注意：此监听器必须在页面其他脚本注册之前执行（run-at: document-start 保证这一点），
   * 才能通过捕获阶段优先拦截并阻断它们。
   */
  document.addEventListener(
    'copy',
    (event) => {
      event.stopImmediatePropagation();
    },
    true // 使用捕获阶段，优先于页面脚本的冒泡阶段处理器
  );
})();
