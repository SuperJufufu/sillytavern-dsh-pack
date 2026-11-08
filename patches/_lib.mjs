// 补丁公共工具（不单独执行）
// 适用版本：SillyTavern 1.19.x
// 修改文件：无
// license: AGPL-3.0
//
// 设计原则：
//   1. 每个锚点在目标文件里必须【恰好出现一次】，否则立即报错，绝不猜测位置；
//   2. 每处改动都有稳定标记（marker），文件里已有标记就跳过 —— 重复运行不会重复插入；
//   3. 补丁只负责算出新内容，落盘 / 备份 / 语法检查统一交给 apply.mjs。

/** 统计 needle 在 haystack 里出现的次数（不依赖正则，避免特殊字符转义问题）。 */
export function countOccurrences(haystack, needle) {
    if (!needle) throw new Error('needle 不能为空');
    let count = 0;
    let index = 0;
    while ((index = haystack.indexOf(needle, index)) !== -1) {
        count += 1;
        index += needle.length;
    }
    return count;
}

/** 要求锚点恰好出现一次，返回原始文本；不满足就抛错（由 apply.mjs 统一报告）。 */
export function requireAnchor(src, needle, label) {
    const count = countOccurrences(src, needle);
    if (count !== 1) {
        throw new Error(`锚点「${label}」命中 ${count} 处（要求恰好 1 处）；目标文件不是受支持的 SillyTavern 1.19.x 版本，或已被其它补丁改过`);
    }
    return src;
}

/** 唯一替换：先断言唯一，再把 needle 换成 replacement（用函数形式避免 $& 等替换符被解释）。 */
export function replaceOnce(src, needle, replacement, label) {
    requireAnchor(src, needle, label);
    return src.replace(needle, () => replacement);
}
