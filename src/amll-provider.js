import { processLyric } from './liblyric/index.ts';

const amllDbServer = "https://amlldb.bikonoo.com/ncm-lyrics/%s.ttml";

export const fetchAMLL = async (id) => {
    const url = amllDbServer.replace("%s", id);
    try {
        const response = await fetch(url);
        if (!response.ok) {
            return null;
        }
        const ttmlContent = await response.text();
        const cleanedTTML = cleanTTMLTranslations(ttmlContent);
        const parsedLines = parseTTML(cleanedTTML);
        if (!parsedLines || parsedLines.length === 0) {
            return null;
        }
        
        // 合并对齐逻辑：将翻译和罗马音合并到主歌词行
        const mergedLines = mergeLyrics(parsedLines);
        
        const converted = convertToRnpFormat(mergedLines);
        return processLyric(converted);
    } catch (e) {
        console.error("AMLL fetch error", e);
        return null;
    }
};

const mergeLyrics = (lines) => {
    // 假设：主歌词没有特殊 role，翻译有 translation，罗马音有 roman
    // 策略：找到时间轴重叠的行，将特殊 role 的行内容合并到主行
    
    // 主内容行包括：无 role 的行（主歌词）和 role 为 background 的行（背景人声）
    // 背景人声不再合并到主歌词，而是作为独立行存在
    const contentLines = lines.filter(l => !l.role || l.role === 'background' || l.role === 'x-background');
    
    const transLines = lines.filter(l => l.role === 'translation' || l.role === 'x-translation');
    const romanLines = lines.filter(l => l.role === 'roman' || l.role === 'x-roman');

    // 如果所有行都没有 role，我们尝试按时间匹配
    if (contentLines.length === lines.length) {
        // 所有行都是内容行，直接返回
        return lines;
    }

    return contentLines.map(line => {
        // 寻找匹配的翻译
        // 注意：如果是背景人声行，可能不应该匹配主歌词的翻译，除非时间完全吻合且意图如此
        // 暂时假设翻译主要是给主歌词的，但如果有重叠也匹配给背景
        const trans = transLines.find(t => isTimeOverlap(line, t));
        if (trans) {
            line.translatedLyric = trans.text;
        }
        
        // 寻找匹配的罗马音
        const roman = romanLines.find(r => isTimeOverlap(line, r));
        if (roman) {
            line.romanLyric = roman.text;
        }

        return line;
    });
};

const isTimeOverlap = (l1, l2) => {
    // 允许 300ms 的误差 (参考 SPlayer)
    return Math.abs(l1.startTime - l2.startTime) < 300;
}

const convertToRnpFormat = (lines) => {
    return lines.map(line => {
        const words = line.words || [];
        const dynamicLyric = words.map(w => ({
            time: w.startTime,
            duration: w.endTime - w.startTime,
            flag: 0,
            word: w.word,
            isCJK: false, // 可以后续优化检测逻辑
            endsWithSpace: w.word.endsWith(' '),
            trailing: false 
        }));

        // 处理对唱 (isDuet)
        // 假设 flag 位掩码：1 = Duet/Right Aligned
        // 虽然 RNP 目前主要靠 isDuet 属性，但保留 flag 兼容性
        const flag = line.isDuet ? 1 : 0; 

        return {
            time: line.startTime,
            duration: line.endTime - line.startTime,
            originalLyric: line.text, 
            translatedLyric: line.translatedLyric || "",
            romanLyric: line.romanLyric || "",
            bgLyric: line.bgLyric || "",
            rawLyric: "", 
            dynamicLyricTime: line.startTime,
            dynamicLyric: dynamicLyric,
            isDuet: line.isDuet,
            // 添加背景行标记
            isBG: line.role === 'background' || line.role === 'x-background'
        };
    });
};

const parseTTML = (ttmlContent) => {
    try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(ttmlContent, "text/xml");
        const body = xmlDoc.getElementsByTagName("body")[0];
        if (!body) return [];

        const lines = [];
        // 递归查找 p 标签，因为可能嵌套在 div 中
        const ps = xmlDoc.getElementsByTagName("p");
        
        // 解析 Agents
        const agents = {};
        const agentTags = xmlDoc.getElementsByTagName("ttm:agent");
        for (let i = 0; i < agentTags.length; i++) {
            const agent = agentTags[i];
            const id = agent.getAttribute("xml:id");
            if (id) {
                agents[id] = agent.textContent; 
            }
        }

        // 记录上一行的 Agent，用于辅助判断 Duet
        let lastAgentId = null;

        for (let i = 0; i < ps.length; i++) {
            const p = ps[i];
            const startTime = parseTime(p.getAttribute("begin"));
            const endTime = parseTime(p.getAttribute("end"));
            
            // 获取 Role
            let role = p.getAttribute("ttm:role") || p.getAttribute("role");
            // 检查父级 div 的 role
            if (!role && p.parentElement && p.parentElement.tagName.toLowerCase() === 'div') {
                role = p.parentElement.getAttribute("ttm:role") || p.parentElement.getAttribute("role");
            }
            
            // 获取 Agent
            const agentId = p.getAttribute("ttm:agent");
            let isDuet = false;
            
            // 增强的对唱检测逻辑
            if (agentId) {
                if (agentId === "v2" || agentId === "female" || agentId === "woman") {
                    isDuet = true;
                } else if (lastAgentId && agentId !== lastAgentId && agentId !== "v1") {
                    // 如果 Agent 切换了，且不是切回主唱(v1)，则可能是对唱
                     // 但这也可能是多人合唱，SPlayer 主要是靠 v2/female 判断
                     // 这里保持保守，主要依赖明确的 ID 或 SPlayer 的逻辑
                }
                lastAgentId = agentId;
            }

            // 遍历子节点以正确处理文本和特殊的 span
            const childNodes = p.childNodes;
            
            let words = [];
            let textContent = "";
            let spanTranslatedLyric = "";
            let spanRomanLyric = "";

            // 临时存储背景人声行，稍后加入 lines
            const bgLinesInThisP = [];

            if (childNodes.length > 0) {
                 for (let j = 0; j < childNodes.length; j++) {
                    const node = childNodes[j];
                    
                    if (node.nodeType === Node.TEXT_NODE) {
                        // 文本节点直接加入主歌词
                        const text = node.textContent; // 保留空格
                        // 如果包含非空白字符，或者不包含换行符（纯空格），则保留
                        if (text.trim() || (!text.includes('\n') && text.length > 0)) {
                            textContent += text;
                            // 文本节点没有具体时间戳，如果需要逐字可能需要估算，或者直接忽略作为逐字
                            // 这里暂时不生成 words 条目，除非之后发现需要
                        }
                    } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === 'span') {
                        const span = node;
                        const spanBegin = parseTime(span.getAttribute("begin"));
                        const spanEnd = parseTime(span.getAttribute("end"));
                        let text = span.textContent || "";
                        
                        // 获取 Span Role
                        const spanRole = span.getAttribute("ttm:role") || span.getAttribute("role");

                        // 提取翻译、罗马音、背景人声
                        if (spanRole === 'x-translation' || spanRole === 'translation') {
                            spanTranslatedLyric += text;
                            continue;
                        }
                        if (spanRole === 'x-roman' || spanRole === 'roman') {
                            spanRomanLyric += text;
                            continue;
                        }
                        if (spanRole === 'x-background' || spanRole === 'background') {
                            // 背景人声作为独立行处理
                            // 去除括号
                            let cleanText = text.trim();
                            if (cleanText.startsWith('(') && cleanText.endsWith(')')) {
                                cleanText = cleanText.slice(1, -1).trim();
                            } else if (cleanText.startsWith('（') && cleanText.endsWith('）')) {
                                cleanText = cleanText.slice(1, -1).trim();
                            }
                            
                            if (cleanText) {
                                bgLinesInThisP.push({
                                    startTime: spanBegin !== null ? spanBegin : startTime,
                                    endTime: spanEnd !== null ? spanEnd : endTime,
                                    words: [], // 暂不处理背景人声的逐字
                                    text: cleanText,
                                    role: 'background',
                                    isDuet: isDuet,
                                    translatedLyric: "", 
                                    romanLyric: "",
                                    bgLyric: "", // 自身就是背景，不需要 bgLyric
                                    isBG: true
                                });
                            }
                            continue;
                        }

                        if (spanBegin !== null && spanEnd !== null) {
                             words.push({
                                startTime: spanBegin,
                                endTime: spanEnd,
                                word: text
                            });
                        }
                        textContent += text;
                    }
                }
            } else {
                 textContent = p.textContent || "";
                 words.push({
                     startTime: startTime,
                     endTime: endTime,
                     word: textContent
                 });
            }
            
            if (words.length === 0 && textContent && !spanTranslatedLyric && !spanRomanLyric) {
                 words.push({
                     startTime: startTime,
                     endTime: endTime,
                     word: textContent
                 });
            }

            // 如果主歌词有内容，或者它是纯背景行但被识别为主行（role=background）
            // 如果 role 是 background，也标记为 isBG
            const isLineBG = role === 'background' || role === 'x-background';
            
            // 如果是纯背景行，且内容在括号内，去除括号
            if (isLineBG) {
                let cleanText = textContent.trim();
                if (cleanText.startsWith('(') && cleanText.endsWith(')')) {
                    cleanText = cleanText.slice(1, -1).trim();
                    textContent = cleanText;
                } else if (cleanText.startsWith('（') && cleanText.endsWith('）')) {
                    cleanText = cleanText.slice(1, -1).trim();
                    textContent = cleanText;
                }
            }

            // 只有当有内容时才添加
            if (textContent.trim() || spanTranslatedLyric || spanRomanLyric) {
                lines.push({
                    startTime,
                    endTime,
                    words,
                    text: textContent,
                    role: role,
                    isDuet: isDuet, 
                    translatedLyric: spanTranslatedLyric,
                    romanLyric: spanRomanLyric,
                    bgLyric: "", // 这里不再由 parseTTML 填充 bgLyric，而是由 mergeLyrics 处理（或者保持独立）
                    isBG: isLineBG
                });
            }

            // 添加提取出的背景人声行
            lines.push(...bgLinesInThisP);
        }
        
        return lines.sort((a, b) => a.startTime - b.startTime);

    } catch (e) {
        console.error("TTML Parse Error", e);
        return [];
    }
}

const parseTime = (timeStr) => {
    if (!timeStr) return null;
    // Format: HH:MM:SS.mmm or MM:SS.mmm
    const parts = timeStr.split(":");
    let seconds = 0;
    if (parts.length === 3) {
        seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
        seconds = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
    } else {
        seconds = parseFloat(timeStr);
    }
    return Math.round(seconds * 1000); // ms
}

const cleanTTMLTranslations = (ttmlContent) => {
    // 移除 XML 声明，避免 DOMParser 解析错误
    ttmlContent = ttmlContent.replace(/<\?xml.*?\?>/, '');

    const lang_counter = (ttml_text) => {
        const langRegex = /(?<=<(span|translation)[^<>]+)xml:lang="([^"]+)"/g;
        const matches = ttml_text.matchAll(langRegex);
        const langSet = new Set();
        for (const match of matches) {
            if (match[2]) langSet.add(match[2]);
        }
        return Array.from(langSet);
    };

    const lang_filter = (langs) => {
        if (langs.length <= 1) return null;
        
        const lang_matcher = (target) => {
            return langs.find((lang) => {
                try {
                    return new Intl.Locale(lang).maximize().script === target;
                } catch {
                    return false;
                }
            });
        };

        const hans_matched = lang_matcher("Hans");
        if (hans_matched) return hans_matched;

        const hant_matched = lang_matcher("Hant");
        if (hant_matched) return hant_matched;

        const major = langs.find((key) => key.startsWith("zh"));
        if (major) return major;

        return langs[0];
    };

    const ttml_cleaner = (ttml_text, major_lang) => {
        if (major_lang === null) return ttml_text;
        // 注意：这里我们保留了 translation 标签，但是只保留匹配语言的
        // 如果不匹配语言，替换为空
        const replacer = (match, lang) => (lang === major_lang ? match : "");
        const translationRegex = /<translation[^>]+xml:lang="([^"]+)"[^>]*>[\s\S]*?<\/translation>/g;
        const spanRegex = /<span[^>]+xml:lang="([^" ]+)"[^>]*>[\s\S]*?<\/span>/g;
        return ttml_text.replace(translationRegex, replacer).replace(spanRegex, replacer);
    };

    const context_lang = lang_counter(ttmlContent);
    const major = lang_filter(context_lang);
    let cleaned_ttml = ttml_cleaner(ttmlContent, major);

    // 移除不必要的换行符，但要小心保留空格
    // return cleaned_ttml.replace(/\n\s*/g, ""); // 此行代码可能导致单词粘连，移除
    return cleaned_ttml;
};
