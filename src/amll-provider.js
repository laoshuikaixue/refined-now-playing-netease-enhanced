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
    // 过滤出主歌词行（无 role 或 role 为 background）
    const contentLines = lines.filter(l => !l.role || l.role === 'background' || l.role === 'x-background');
    const transLines = lines.filter(l => l.role === 'translation' || l.role === 'x-translation');
    const romanLines = lines.filter(l => l.role === 'roman' || l.role === 'x-roman');

    // 如果所有行都是主内容行，直接返回
    if (contentLines.length === lines.length) {
        return lines;
    }

    return contentLines.map(line => {
        // 寻找时间重叠的翻译行
        const trans = transLines.find(t => isTimeOverlap(line, t));
        if (trans) {
            line.translatedLyric = trans.text;
        }
        
        // 寻找时间重叠的罗马音行
        const roman = romanLines.find(r => isTimeOverlap(line, r));
        if (roman) {
            line.romanLyric = roman.text;
        }

        return line;
    });
};

const isTimeOverlap = (l1, l2) => {
    // 允许 300ms 的误差
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
            isCJK: false,
            endsWithSpace: w.word.endsWith(' '),
            trailing: false 
        }));

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
        const ps = xmlDoc.getElementsByTagName("p");
        
        let lastAgentId = null;

        for (let i = 0; i < ps.length; i++) {
            const p = ps[i];
            const startTime = parseTime(p.getAttribute("begin"));
            const endTime = parseTime(p.getAttribute("end"));
            
            // 获取 Role，如果自身没有则检查父级 div
            let role = p.getAttribute("ttm:role") || p.getAttribute("role");
            if (!role && p.parentElement && p.parentElement.tagName.toLowerCase() === 'div') {
                role = p.parentElement.getAttribute("ttm:role") || p.parentElement.getAttribute("role");
            }
            
            // 对唱检测逻辑
            const agentId = p.getAttribute("ttm:agent");
            let isDuet = false;
            if (agentId) {
                if (agentId === "v2" || agentId === "female" || agentId === "woman") {
                    isDuet = true;
                }
                lastAgentId = agentId;
            }

            const childNodes = p.childNodes;
            let words = [];
            let textContent = "";
            let spanTranslatedLyric = "";
            let spanRomanLyric = "";
            let pendingText = "";

            const bgLinesInThisP = [];

            if (childNodes.length > 0) {
                 for (let j = 0; j < childNodes.length; j++) {
                    const node = childNodes[j];
                    
                    if (node.nodeType === Node.TEXT_NODE) {
                        const text = node.textContent;
                        // 保留非空文本或纯换行以外的字符
                        if (text.trim() || (!text.includes('\n') && text.length > 0)) {
                            textContent += text;
                            if (words.length > 0) {
                                words[words.length - 1].word += text;
                            } else {
                                pendingText += text;
                            }
                        }
                    } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === 'span') {
                        const span = node;
                        const spanBegin = parseTime(span.getAttribute("begin"));
                        const spanEnd = parseTime(span.getAttribute("end"));
                        let text = span.textContent || "";
                        
                        const spanRole = span.getAttribute("ttm:role") || span.getAttribute("role");

                        if (spanRole === 'x-translation' || spanRole === 'translation') {
                            spanTranslatedLyric += text;
                            continue;
                        }
                        if (spanRole === 'x-roman' || spanRole === 'roman') {
                            spanRomanLyric += text;
                            continue;
                        }
                        // 处理背景人声
                        if (spanRole === 'x-background' || spanRole === 'background' || spanRole === 'x-bg') {
                            let cleanText = text.trim();
                            let bgWords = [];
                            
                            // 检查是否有逐字信息（子 span）
                            if (span.childNodes.length > 0) {
                                for (let k = 0; k < span.childNodes.length; k++) {
                                    const subNode = span.childNodes[k];
                                    if (subNode.nodeType === Node.ELEMENT_NODE && subNode.tagName.toLowerCase() === 'span') {
                                        const subBegin = parseTime(subNode.getAttribute("begin"));
                                        const subEnd = parseTime(subNode.getAttribute("end"));
                                        const subText = subNode.textContent || "";
                                        if (subBegin !== null && subEnd !== null) {
                                            bgWords.push({
                                                startTime: subBegin,
                                                endTime: subEnd,
                                                word: subText
                                            });
                                        }
                                    }
                                }
                            }

                            // 如果没有子 span 但有时间戳，整体作为一个词
                            if (bgWords.length === 0 && cleanText && spanBegin !== null && spanEnd !== null) {
                                bgWords.push({
                                    startTime: spanBegin,
                                    endTime: spanEnd,
                                    word: cleanText
                                });
                            }

                            // 去除首尾括号
                            cleanText = removeParentheses(cleanText);
                            if (bgWords.length > 0) {
                                bgWords[0].word = removeLeadingParenthesis(bgWords[0].word);
                                bgWords[bgWords.length - 1].word = removeTrailingParenthesis(bgWords[bgWords.length - 1].word);
                            }
                            
                            if (cleanText || bgWords.length > 0) {
                                bgLinesInThisP.push({
                                    startTime: spanBegin !== null ? spanBegin : startTime,
                                    endTime: spanEnd !== null ? spanEnd : endTime,
                                    words: bgWords, 
                                    text: cleanText,
                                    role: 'background',
                                    isDuet: isDuet,
                                    translatedLyric: "", 
                                    romanLyric: "",
                                    bgLyric: "",
                                    isBG: true
                                });
                            }
                            continue;
                        }

                        if (spanBegin !== null && spanEnd !== null) {
                             let wordText = text;
                             if (pendingText) {
                                 wordText = pendingText + text;
                                 pendingText = "";
                             }
                             words.push({
                                startTime: spanBegin,
                                endTime: spanEnd,
                                word: wordText
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

            const isLineBG = role === 'background' || role === 'x-background';
            if (isLineBG) {
                textContent = removeParentheses(textContent);
            }

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
                    bgLyric: "",
                    isBG: isLineBG
                });
            }

            lines.push(...bgLinesInThisP);
        }
        
        return lines.sort((a, b) => a.startTime - b.startTime);

    } catch (e) {
        console.error("TTML Parse Error", e);
        return [];
    }
}

const removeParentheses = (text) => {
    let cleanText = text.trim();
    if ((cleanText.startsWith('(') && cleanText.endsWith(')')) || 
        (cleanText.startsWith('（') && cleanText.endsWith('）'))) {
        return cleanText.slice(1, -1).trim();
    }
    return cleanText;
}

const removeLeadingParenthesis = (text) => {
    let t = text.trim();
    if (t.startsWith('(') || t.startsWith('（')) {
        return t.substring(1);
    }
    return text;
}

const removeTrailingParenthesis = (text) => {
    let t = text.trim();
    if (t.endsWith(')') || t.endsWith('）')) {
        return t.slice(0, -1);
    }
    return text;
}

const parseTime = (timeStr) => {
    if (!timeStr) return null;
    const parts = timeStr.split(":");
    let seconds = 0;
    if (parts.length === 3) {
        seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
        seconds = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
    } else {
        seconds = parseFloat(timeStr);
    }
    return Math.round(seconds * 1000);
}

const cleanTTMLTranslations = (ttmlContent) => {
    // 移除 XML 声明
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
        // 仅保留匹配语言的 translation 和 span 标签
        const replacer = (match, lang) => (lang === major_lang ? match : "");
        const translationRegex = /<translation[^>]+xml:lang="([^"]+)"[^>]*>[\s\S]*?<\/translation>/g;
        const spanRegex = /<span[^>]+xml:lang="([^" ]+)"[^>]*>[\s\S]*?<\/span>/g;
        return ttml_text.replace(translationRegex, replacer).replace(spanRegex, replacer);
    };

    const context_lang = lang_counter(ttmlContent);
    const major = lang_filter(context_lang);
    return ttml_cleaner(ttmlContent, major);
};
