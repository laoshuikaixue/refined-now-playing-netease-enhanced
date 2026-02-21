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
    const mainLines = lines.filter(l => !l.role);
    const transLines = lines.filter(l => l.role === 'translation' || l.role === 'x-translation');
    const romanLines = lines.filter(l => l.role === 'roman' || l.role === 'x-roman');
    // 还有背景人声等，暂时作为主歌词处理或者忽略，如果它们没有 role，就会被当做主歌词，导致多行重叠
    // 如果 AMLL 的背景人声有 role="background"，我们需要处理
    const bgLines = lines.filter(l => l.role === 'background' || l.role === 'x-background');

    // 如果没有明确的 role，可能是通过 xml:lang 区分的，但 cleanTTMLTranslations 已经过滤了语言
    // 如果 cleanTTMLTranslations 保留了翻译（因为它是目标语言），那么翻译行现在应该还在 lines 里
    // 但是它是一个单独的 <p>。
    
    // 如果所有行都没有 role，我们尝试按时间匹配
    if (mainLines.length === lines.length) {
        // 所有行都没有 role，可能是交替行或者真的是多行歌词
        // 这种情况下很难区分，直接返回原样
        return lines;
    }

    return mainLines.map(line => {
        // 寻找匹配的翻译
        const trans = transLines.find(t => isTimeOverlap(line, t));
        if (trans) {
            line.translatedLyric = trans.text;
        }
        
        // 寻找匹配的罗马音
        const roman = romanLines.find(r => isTimeOverlap(line, r));
        if (roman) {
            line.romanLyric = roman.text;
        }

        // 背景人声合并到主歌词，用括号包裹
        const bg = bgLines.find(b => isTimeOverlap(line, b));
        if (bg) {
            line.text += ` (${bg.text})`;
            // 如果背景人声有逐字，也合并? 比较复杂，暂时只合并文本
        }

        return line;
    });
};

const isTimeOverlap = (l1, l2) => {
    // 允许 100ms 的误差
    return Math.abs(l1.startTime - l2.startTime) < 100;
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

        // 处理对唱 (isDuet)
        // 在 RNP 格式中，flag = 1 可能代表第二歌手/对唱 (需要确认 RNP 格式定义)
        // 假设 flag 位掩码：1 = Duet/Right Aligned
        const flag = line.isDuet ? 1 : 0; 

        return {
            time: line.startTime,
            duration: line.endTime - line.startTime,
            originalLyric: line.text, 
            translatedLyric: line.translatedLyric || "",
            romanLyric: line.romanLyric || "",
            rawLyric: "", 
            dynamicLyricTime: line.startTime,
            dynamicLyric: dynamicLyric,
            // 传递对唱标记
            // 如果 liblyric processLyric 会覆盖 flag，我们需要确认
            // 暂时先放在这里，如果 processLyric 不支持，可能需要修改 processLyric
            isDuet: line.isDuet 
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
        
        // AMLL 规范中，Agent (歌手) 信息可能在 metadata 中定义，并在 p 或 span 中引用
        // 或者直接通过 ttm:agent 属性
        // 但最常见的是通过解析歌词内容或 role 来推断
        // SPlayer 的 parseTTML 实现似乎会返回 isDuet 字段
        
        // 简单的对唱检测逻辑：
        // 1. 检查 ttm:agent 属性
        // 2. 检查是否有括号包裹的歌手名 (SPlayer 的 lyricStripper 有处理，但那是针对 LRC)
        // 3. AMLL 数据源通常会标记 role 或 agent
        
        const agents = {};
        const agentTags = xmlDoc.getElementsByTagName("ttm:agent");
        for (let i = 0; i < agentTags.length; i++) {
            const agent = agentTags[i];
            const id = agent.getAttribute("xml:id");
            if (id) {
                agents[id] = agent.textContent; // 或者 agent.getAttribute("ttm:name")?
            }
        }
        console.log("AMLL Agents:", agents);

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
            
            // 如果有 agentId，且不是第一个定义的 agent，或者是特定的 "v2" 等，可能就是对唱
            // 简单策略：如果 agentId 存在且不同于前一行（或者是特定的 ID），标记为 Duet
            // 更好的策略：AMLL 规范中，通常 v1 是主唱，v2 是副唱/对唱
            if (agentId === "v2" || agentId === "female" || (agentId && agentId !== "v1")) {
                isDuet = true;
            }

            if (agentId) {
                console.log(`Line ${i}: agentId=${agentId}, isDuet=${isDuet}, text=${p.textContent}`);
            }

            const spans = p.getElementsByTagName("span");
            
            let words = [];
            let textContent = "";

            if (spans.length > 0) {
                 for (let j = 0; j < spans.length; j++) {
                    const span = spans[j];
                    const spanBegin = parseTime(span.getAttribute("begin"));
                    const spanEnd = parseTime(span.getAttribute("end"));
                    const text = span.textContent || "";
                    
                    // 如果 span 有 role，覆盖 p 的 role (虽然不常见)
                    // const spanRole = span.getAttribute("ttm:role") || span.getAttribute("role");

                    if (spanBegin !== null && spanEnd !== null) {
                         words.push({
                            startTime: spanBegin,
                            endTime: spanEnd,
                            word: text
                        });
                    }
                    textContent += text;
                }
            } else {
                 textContent = p.textContent || "";
                 words.push({
                     startTime: startTime,
                     endTime: endTime,
                     word: textContent
                 });
            }
            
            if (words.length === 0 && textContent) {
                 words.push({
                     startTime: startTime,
                     endTime: endTime,
                     word: textContent
                 });
            }

            lines.push({
                startTime,
                endTime,
                words,
                text: textContent,
                role: role,
                isDuet: isDuet, // 添加 isDuet 属性
                translatedLyric: "",
                romanLyric: ""
            });
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

    return cleaned_ttml.replace(/\n\s*/g, "");
};
