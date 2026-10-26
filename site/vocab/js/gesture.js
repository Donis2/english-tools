// gesture.js - 滑动翻页手势助手
// 横向滑动触发上一个/下一个，像电子书翻页；
// 与点击（翻面看释义）区分：横向滑动超过阈值才算翻页，并吞掉随之而来的 click。

window.createSwipe = function createSwipe({ onPrev, onNext, threshold = 60 }) {
  let startX = 0;
  let startY = 0;
  let isSwiping = false;
  let handled = false;

  return {
    onTouchStart(e) {
      if (!e.touches || !e.touches.length) return;
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      isSwiping = false;
      handled = false;
    },

    onTouchMove(e) {
      if (!e.touches || !e.touches.length) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      // 横向位移明显大于纵向才算滑动（避免与页面上下滚动冲突）
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
        isSwiping = true;
      }
    },

    onTouchEnd(e) {
      if (!isSwiping) return;
      if (!e.changedTouches || !e.changedTouches.length) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      // 只要是横向滑动就吞掉 click，避免误翻面
      handled = true;
      if (dx <= -threshold) {
        if (onNext) onNext();
      } else if (dx >= threshold) {
        if (onPrev) onPrev();
      }
      isSwiping = false;
    },

    // 卡片 click 处理：若刚完成一次滑动，返回 true 表示应忽略本次点击
    shouldIgnoreClick() {
      if (handled) {
        handled = false;
        return true;
      }
      return false;
    }
  };
};