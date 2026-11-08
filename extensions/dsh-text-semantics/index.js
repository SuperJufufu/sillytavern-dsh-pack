// dsh-text-semantics —— 颜色/排版都在 style.css 里；这个文件只做版本标记和简单自检。
const VERSION = '1.1.0';

try {
    window.__DSH_TEXT_SEMANTICS = Object.freeze({
        version: VERSION,
        scheme: 'V1-vivid',
        palette: {
            narr: '#EBD39A',
            quote: '#FF9F2E',
            thought: '#D6A8FF',
            action: '#66E6C4',
            system: '#8FC8F5',
        },
        lineHeight: 1.8,
        fontSize: '15px',
    });
    console.log('[dsh-text-semantics] loaded v' + VERSION + '（V1·鲜艳五色）');
} catch (error) {
    console.error('[dsh-text-semantics] init failed', error);
}
