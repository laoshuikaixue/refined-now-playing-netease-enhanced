import { parseLyric } from './liblyric/index.ts'
import { cyrb53, getSetting } from './utils.js'
import { fetchAMLL } from './amll-provider.js'

const preProcessLyrics = (lyrics) => {
	if (!lyrics) return null;
	if (!lyrics.lrc) lyrics.lrc = {};

	const original = (lyrics?.lrc?.lyric ?? '').replace(/\u3000/g, ' ');
	const translation = lyrics?.ytlrc?.lyric ?? lyrics?.ttlrc?.lyric ?? lyrics?.tlyric?.lyric ?? '';
	const roma = lyrics?.yromalrc?.lyric ?? lyrics?.romalrc?.lyric ?? '';
	const dynamic = lyrics?.yrc?.lyric ?? '';
	const approxLines = original.match(/\[(.*?)\]/g)?.length ?? 0;

	const parsed = parseLyric(
		original,
		translation,
		roma,
		dynamic
	);
	// 某些特殊情况（逐字歌词残缺不全）
	if (approxLines - parsed.length > approxLines * 0.7) { 
		return parseLyric(
			original,
			translation,
			roma
		);
	}
	return parsed;
}


const processLyrics = (lyrics) => {
	for (const line of lyrics) {
		if (line.originalLyric == '') {
			line.isInterlude = true;
		}
	}
	return lyrics;
}

let currentRawLRC = null;

const _onProcessLyrics = window.onProcessLyrics ?? ((x) => x);
window.onProcessLyrics = (_rawLyrics, songID) => {
	if (!_rawLyrics || _rawLyrics?.data === -400) return _onProcessLyrics(_rawLyrics, songID);

	let rawLyrics = _rawLyrics;
	// 本地歌词处理
	if (typeof(_rawLyrics) === 'string') { 
		rawLyrics = {
			lrc: {
				lyric: _rawLyrics,
			},
			source: {
				name: '本地',
			}
		}
	}

	if ((rawLyrics?.lrc?.lyric ?? '') != currentRawLRC) {
		console.log('Update Raw Lyrics', rawLyrics);
		currentRawLRC = (rawLyrics?.lrc?.lyric ?? '') ;
		const preprocessedLyrics = preProcessLyrics(rawLyrics);
		setTimeout(async () => {
			let processedLyricsToUse = preprocessedLyrics;
			const enableAMLL = getSetting('enable-amll', false);
			if (enableAMLL) {
				const playingId = betterncm.ncm.getPlaying().id;
				const amll = await fetchAMLL(playingId);
				if (amll && amll.length > 0) {
					processedLyricsToUse = amll;
					console.log('Using AMLL Lyrics');
				}
			}

			const processedLyrics = await processLyrics(processedLyricsToUse);
			const lyrics = {
				lyrics: processedLyrics,
				contributors: {}
			}

			if (processedLyrics[0]?.unsynced) {
				lyrics.unsynced = true;
			}

			if (rawLyrics?.lyricUser) {
				lyrics.contributors.original = {
					name: rawLyrics.lyricUser.nickname,
					userid: rawLyrics.lyricUser.userid,
				}
			}
			if (rawLyrics?.transUser) {
				lyrics.contributors.translation = {
					name: rawLyrics.transUser.nickname,
					userid: rawLyrics.transUser.userid,
				}
			}
			lyrics.contributors.roles = rawLyrics?.roles ?? [];
			lyrics.contributors.roles = lyrics.contributors.roles.filter(role => {
				if (role.artistMetaList.length == 1 && role.artistMetaList[0].artistName == '无' && role.artistMetaList[0].artistId == 0) {
					return false;
				}
				return true;
			});
			// 合并相同的贡献者角色
			for (let i = 0; i < lyrics.contributors.roles.length; i++) {
				const metaList = JSON.stringify(lyrics.contributors.roles[i].artistMetaList);
				for (let j = i + 1; j < lyrics.contributors.roles.length; j++) {
					if (JSON.stringify(lyrics.contributors.roles[j].artistMetaList) === metaList) {
						lyrics.contributors.roles[i].roleName += `、${lyrics.contributors.roles[j].roleName}`;
						lyrics.contributors.roles.splice(j, 1);
						j--;
					}
				}
			}
			

			if (rawLyrics?.source) {
				lyrics.contributors.lyricSource = rawLyrics.source;
			}
			lyrics.hash = `${betterncm.ncm.getPlaying().id}-${cyrb53(processedLyrics.map((x) => x.originalLyric).join('\\'))}`;
			window.currentLyrics = lyrics;
			console.group('Update Processed Lyrics');
			console.log('lyrics', window.currentLyrics.lyrics);
			console.log('contributors', window.currentLyrics.contributors);
			console.log('hash', window.currentLyrics.hash);
			console.groupEnd();
			document.dispatchEvent(new CustomEvent('lyrics-updated', {detail: window.currentLyrics}));
		}, 0);
	}
	return _onProcessLyrics(_rawLyrics, songID);
}
