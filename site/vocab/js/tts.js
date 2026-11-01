// tts.js - 单词发音
// 优先使用在线真人录音（与词典网站一致），失败或离线时回退到系统语音合成
//
// 在线音频：有道词典发音接口（美音），单词级请求，浏览器会缓存
// 本地回退：
//   - Windows: Edge / Chrome 自带 Microsoft 英语语音
//   - macOS: Safari / Chrome 自带 Siri / Samantha 英语语音
//   - Android: Chrome 自带 Google 英语语音

const TTS = {
  // 当前是否支持语音合成
  supported: typeof window !== 'undefined' && 'speechSynthesis' in window,

  // 是否优先使用在线真人发音
  online: true,

  // 选中的英文语音（在线音频失败时使用）
  voice: null,

  // 正在播放的在线音频
  audio: null,

  // 默认语速（本地合成时使用，1=正常）
  rate: 0.9,

  // 初始化：挑选英文语音
  init() {
    if (!this.supported) {
      console.warn('[tts] 当前浏览器不支持语音合成');
      return;
    }

    // voices 加载是异步的，需要监听 onvoiceschanged
    const pickVoice = () => {
      const voices = speechSynthesis.getVoices();
      if (voices.length === 0) return;

      // 优先选清晰度高的英语语音：
      // 1) Natural/Neural/Online（Edge 神经网络语音，最清晰）
      // 2) Google US English（Android/Chrome 高质量）
      // 3) 常见美式女声（Zira/Aria/Jenny/Samantha/Siri 等）
      // 4) 任意 en-US → 任意 en-*
      // 没有英语语音时保持 null，让浏览器按 en-US 自己选，绝不退回中文语音
      const en = voices.filter(v => v.lang && v.lang.toLowerCase().startsWith('en'));
      this.voice = en.find(v => /natural|neural|online/i.test(v.name))
                || en.find(v => /google.*(us english|english)/i.test(v.name))
                || en.find(v => v.lang.toLowerCase() === 'en-us' && /samantha|jenny|aria|siri|zira|female/i.test(v.name))
                || en.find(v => v.lang.toLowerCase() === 'en-us')
                || en[0]
                || null;
      console.log('[tts] 回退语音:', this.voice ? this.voice.name : '无英语语音，交给浏览器按 en-US 选择');
    };

    pickVoice();
    if (!this.voice) {
      speechSynthesis.onvoiceschanged = pickVoice;
    }
  },

  // 朗读一个单词或短语
  // @param {string} text 要朗读的英文
  // @param {object} opts { rate?: number } 可选参数
  speak(text, opts = {}) {
    const word = String(text || '').trim();
    if (!word) return;

    // 先停掉正在播放的，避免快速连点时叠音
    this.stop();

    if (this.online) {
      const url = 'https://dict.youdao.com/dictvoice?type=2&audio=' + encodeURIComponent(word);
      const audio = new Audio(url);
      audio.preload = 'auto';
      this.audio = audio;

      let finished = false;
      const fallback = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        audio.pause();
        if (this.audio === audio) this.audio = null;
        this.speakLocal(word, opts);
      };

      // 网络慢或接口异常时，最多等 2.5 秒就退回本地语音
      const timer = setTimeout(fallback, 2500);
      audio.onplaying = () => {
        finished = true;
        clearTimeout(timer);
      };
      audio.onerror = fallback;
      audio.onended = () => {
        if (this.audio === audio) this.audio = null;
      };

      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(fallback);
      return;
    }

    this.speakLocal(word, opts);
  },

  // 系统语音合成（离线回退）
  speakLocal(text, opts = {}) {
    if (!this.supported) return;

    speechSynthesis.cancel();

    const utter = new SpeechSynthesisUtterance(text);
    // 只有在确认是英语语音时才指定，避免用中文语音念英文
    if (this.voice && this.voice.lang && this.voice.lang.toLowerCase().startsWith('en')) {
      utter.voice = this.voice;
    }
    utter.lang = 'en-US';
    utter.rate = opts.rate || this.rate;
    utter.pitch = 1;
    utter.volume = 1;

    speechSynthesis.speak(utter);
  },

  // 停止朗读
  stop() {
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    if (this.supported) speechSynthesis.cancel();
  }
};

// 页面加载时初始化
TTS.init();

window.TTS = TTS;
