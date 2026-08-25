// Simplified and Traditional Han, folded into one another as SPELLINGS.
//
// This is the root cause of a delivered leak. The first export shipped a
// portfolio and salary figures because the declared redaction strings were
// Traditional and the corpus wrote the same words in Simplified. The
// substituter did not match them and the residue scan did not find them, IN
// AGREEMENT, because both read `table.entries` and the entries carried one
// script. Two checks that consult the same table are one check.
//
// Measured over the real corpus root (2026-08-25, 4,132 session files,
// 1.97 billion characters): Traditional-only characters 5,751,541
// occurrences, Simplified-only characters 38,621. Both scripts are present in
// the same corpus, so the fold is not a hypothetical.
//
// No npm, so no OpenCC. A full mapping is several thousand characters, most of
// which cannot appear in an identity string.
//
// SUBSET RULE. A pair earns its place when the Traditional character belongs
// to the vocabulary a Han IDENTITY string is built from: family names, the
// given-name stock in common use, the fixed words of a registered company
// name, and administrative or postal vocabulary. In practice that is the
// characters carrying one of the productive systematic simplifications
// (言->讠, 金->钅, 糸->纟, 馬->马, 門->门, 車->车, 貝->贝, 見->见, 頁->页,
// 食->饣, 魚->鱼, 鳥->鸟, 風->风, 韋->韦, 專->专, 東->东, 長->长, 辵, 囗,
// 广/厂), plus the individually simplified characters that show up in names,
// company names and addresses.
//
// OUTSIDE IT, deliberately: general prose vocabulary and rare characters. A
// character the table does not know is left alone, so a spelling carrying one
// still folds around it and its occurrences in the other script are missed only
// for that character. That is a miss, not a corruption, which is the same
// direction caseInsensitive() takes for Turkish dotted I.
//
// The ambiguous pairs are handled separately and are NOT simply omitted: see
// ONE_WAY and AMBIGUOUS_BACK below. Omitting them would lose 發展 -> 发展, which
// is in half the company names there are.

/**
 * Pairs that fold in BOTH directions.
 *
 * Admitted only when the Simplified form is not itself a distinct Traditional
 * character and no other Traditional character folds onto it, so the mapping
 * restricted to this list is a bijection and a round trip is the identity.
 * Written `TS` per token, whitespace separated, so a reader can check one pair
 * without counting characters.
 */
const BIJECTIVE = [
  // Family names that differ between the scripts. The ones that do not differ
  // (王 李 周 林 高 郭 何 宋 徐 朱 …) need no entry and are the majority.
  '陳陈 劉刘 張张 楊杨 趙赵 黃黄 吳吴 鄭郑 馮冯 蔣蒋 韓韩 葉叶 呂吕 盧卢 蕭萧 龔龚 賈贾 鄒邹 譚谭',
  '顏颜 龍龙 賴赖 藍蓝 鄧邓 許许 謝谢 羅罗 孫孙 馬马 錢钱 衛卫 嚴严 華华 蘇苏 魯鲁 韋韦 鳳凤',
  '費费 賀贺 湯汤 畢毕 鄔邬 樂乐 時时 齊齐 顧顾 談谈 龐庞 紀纪 婁娄 閔闵 強强 駱骆 萬万 經经',
  '單单 諸诸 鈕钮 竇窦 陸陆 榮荣 儲储 烏乌 宮宫 欒栾 厲厉 薊蓟 懷怀 喬乔 蒼苍 聞闻 貢贡 勞劳',
  '卻却 壽寿 莊庄 閻阎 習习 終终 祿禄 闕阙 歐欧 鞏巩 厙厍 聶聂 饒饶 鄉乡 鄰邻 藺蔺',

  // 言 -> 讠. The largest productive family, and the one a company name and a
  // job title are mostly built from.
  '說说 話话 語语 讀读 誰谁 請请 認认 識识 訊讯 記记 訂订 計计 論论 設设 訪访 詞词 譯译 試试',
  '詩诗 誠诚 課课 調调 講讲 謀谋 證证 議议 護护 讓让 詳详 訓训 訴诉 診诊 評评 詢询 誤误 譽誉',
  '謹谨 謙谦 諾诺 謠谣 誘诱 誼谊 諒谅 謎谜 訟讼 詐诈 誕诞 諷讽 謬谬 譜谱 謂谓 諧谐 譴谴 謄誊',
  '誦诵 諺谚 諜谍 諱讳 謊谎 詭诡 詫诧 誇夸',

  // 金 -> 钅
  '銀银 鐵铁 鋼钢 銷销 鏈链 鍵键 鎖锁 錯错 鏡镜 鑽钻 鋁铝 銅铜 鈴铃 錦锦 鍛锻 針针 釣钓',
  '鑄铸 鋒锋 銘铭 銳锐 鑑鉴 錄录 銜衔 鑼锣 鈔钞 鍋锅 鎊镑 鑰钥 鎮镇 錠锭 鋸锯 鑲镶 鍍镀 錫锡',
  '鈣钙 鈉钠 鉀钾 鏟铲 鏽锈 銬铐',

  // 糸 -> 纟
  '級级 紅红 紙纸 純纯 線线 給给 結结 統统 綠绿 維维 網网 編编 縣县 織织 續续 總总 績绩 繼继',
  '約约 紋纹 納纳 紐纽 細细 組组 絕绝 絡络 綁绑 綜综 緊紧 緣缘 緩缓 練练 縮缩 繩绳 纖纤 紛纷',
  '綱纲 緒绪 綢绸 縫缝 繳缴 繹绎 纜缆 紳绅 絨绒 綻绽 綿绵 繡绣 纏缠 縱纵 繪绘 緝缉 綴缀 綽绰',
  '繽缤 紗纱 絞绞 紡纺 縷缕 綺绮 緬缅',

  // 馬 -> 马
  '媽妈 嗎吗 碼码 罵骂 驗验 驅驱 駕驾 騎骑 驚惊 駐驻 駛驶 騙骗 驛驿 騰腾 驟骤 馳驰 馴驯 駁驳',
  '騷骚 驕骄 駿骏 騾骡 驢驴 駝驼 駭骇 騁骋 篤笃',

  // 門 -> 门
  '門门 們们 問问 間间 閉闭 開开 關关 閣阁 閱阅 闖闯 闊阔 閩闽 閃闪 閘闸 闡阐 閥阀 閨闺 悶闷',
  '潤润 閏闰 鬧闹 闌阑 閹阉 闔阖',

  // 車 -> 车
  '軍军 輪轮 轉转 軟软 較较 輕轻 輸输 載载 輔辅 輯辑 轟轰 軌轨 輛辆 輩辈 轄辖 轎轿 輝辉 輾辗',
  '軸轴 輻辐 轅辕 軒轩 斬斩 暫暂 漸渐 慚惭 塹堑 軋轧 輟辍',

  // 貝 -> 贝
  '買买 賣卖 貨货 賽赛 質质 貴贵 資资 賬账 賺赚 贈赠 賠赔 賦赋 賓宾 貧贫 貪贪 責责 賢贤',
  '賞赏 購购 財财 貼贴 賭赌 貸贷 貿贸 賊贼 贏赢 貫贯 貞贞 負负 員员 損损 圓圆 賤贱 贍赡 賄贿',
  '賂赂 贓赃 賜赐 贖赎 贅赘 販贩 貶贬',

  // 見 -> 见, 頁 -> 页
  '見见 現现 視视 規规 覺觉 觀观 親亲 覽览 覓觅',
  '頁页 頭头 題题 願愿 預预 領领 顯显 類类 額额 順顺 項项 頂顶 顆颗 頻频 頒颁 頌颂 顛颠 顫颤',
  '頗颇 頸颈 頰颊 顱颅 頑顽 顴颧',

  // 食 -> 饣, 魚 -> 鱼, 鳥 -> 鸟, 風 -> 风
  '飯饭 館馆 餓饿 飲饮 飾饰 餅饼 養养 餃饺 饋馈 餡馅 饅馒 餛馄 飩饨',
  '魚鱼 鮮鲜 鯨鲸 鱗鳞 鮑鲍 鯉鲤 鯊鲨 鰻鳗 鮭鲑 鱷鳄 鰭鳍',
  '鳥鸟 鴻鸿 鴨鸭 鵝鹅 鴉鸦 鷹鹰 鳴鸣 鵬鹏 鶴鹤 鴿鸽 鵲鹊 鷗鸥 鶯莺 鴕鸵 鸚鹦 鵡鹉 鷺鹭 鳩鸠',
  '風风 楓枫 瘋疯 飄飘 飆飙',

  // 韋 -> 韦, 專 -> 专, 東 -> 东, 長 -> 长, 為 -> 为
  '偉伟 違违 圍围 緯纬 葦苇 瑋玮 煒炜',
  '專专 傳传 團团 磚砖',
  '東东 凍冻 棟栋 揀拣 諫谏',
  '長长 帳帐 脹胀 漲涨',
  '為为 偽伪',

  // 辵. A place name and a street are mostly built from these.
  '過过 這这 進进 遠远 邊边 運运 連连 遲迟 適适 遞递 選选 遷迁 邁迈 還还 邏逻 遼辽 達达 遺遗',
  '遙遥 遜逊',

  // 囗, 广, 厂
  '國国 圖图 園园 區区',
  '廣广 廠厂 應应 廢废 廳厅 慶庆 廚厨 廈厦 廟庙 廬庐 廁厕 厭厌 壓压',

  // Individually simplified characters in common use. This is the given-name
  // and company-name stock: the half of a Han identity string the systematic
  // families above do not reach.
  '學学 會会 產产 業业 藥药 際际 價价 億亿 儀仪 個个 從从 眾众 醫医 屬属 麗丽 與与 舉举 興兴',
  '農农 藝艺 蘭兰 灣湾 寶宝 實实 寫写 導导 對对 樹树 標标 檢检 機机 權权 極极 構构 樣样 橋桥',
  '檔档 櫃柜 欄栏 樓楼 環环 壞坏 陽阳 陰阴 隨随 險险 隱隐 階阶 隊队 陣阵 節节 築筑 簡简 籃篮',
  '篩筛 籌筹 籠笼 聽听 職职 聯联 聲声 聰聪 處处 虛虚 慮虑 號号 點点 熱热 燈灯 燒烧 營营 爐炉',
  '煩烦 燦灿 燙烫 獨独 獻献 獎奖 獵猎 憂忧 憲宪 憐怜 懶懒 懼惧 憶忆 態态 戀恋 擊击 擔担 擁拥',
  '擇择 擠挤 擴扩 掃扫 撓挠 擾扰 攝摄 攜携 擬拟 據据 擺摆 撲扑 撿捡 擰拧 擋挡 揮挥 換换 撥拨',
  '擲掷 擱搁 歸归 歲岁 歡欢 殺杀 殼壳 毀毁 氣气 氫氢 決决 淺浅 潔洁 濟济 濕湿 潛潜 澤泽 濱滨',
  '濾滤 灑洒 滯滞 溝沟 漢汉 淚泪 湊凑 減减 測测 濃浓 潰溃 瑪玛 璽玺 療疗 癢痒 癡痴 盡尽 監监',
  '盤盘 睜睁 矚瞩 礦矿 礙碍 硯砚 磯矶 禮礼 禪禅 種种 積积 稱称 穩稳 窮穷 竊窃 窯窑 競竞 筆笔',
  '糧粮 罷罢 罰罚 聖圣 腦脑 腸肠 膚肤 臉脸 臘腊 膽胆 脅胁 腫肿 舊旧 艙舱 艦舰 蓋盖 薦荐 蘋苹',
  '薩萨 蟲虫 蠟蜡 蝦虾 蠶蚕 蟬蝉 補补 襯衬 襪袜 裝装 褲裤 觸触 趕赶 趨趋 躍跃 蹤踪 踐践 醬酱',
  '釀酿 釋释 雖虽 雙双 雜杂 雞鸡 難难 離离 電电 霧雾 靈灵 靜静 響响 飛飞 鹽盐 麥麦 黨党 齒齿',
  '齡龄 龜龟 協协 務务 辦办 師师 溫温 別别 滿满 貝贝 島岛 嶺岭 崗岗 壩坝 陝陕 濰潍 灤滦',
  '綏绥 撫抚 淨净 憑凭',
].join(' ');

/**
 * Traditional characters that fold to Simplified but do NOT fold back.
 *
 * Two shapes, and the loader does not care which: several Traditional
 * characters collapsing onto one Simplified character (發/髮 -> 发,
 * 乾/幹 -> 干, 鐘/鍾 -> 钟), and a Simplified form that is ALSO a distinct
 * Traditional character in its own right (後 -> 后, while 后 means empress;
 * 隻 -> 只; 麵 -> 面; 餘 -> 余; 臺 -> 台).
 *
 * Traditional to Simplified is a function and is safe. The reverse is a guess,
 * and a guess here does not merely miss: it mints a needle for a word the
 * person never wrote. So these fold one way and the reverse map never sees
 * them. `王后` (empress) declared in Traditional generates nothing, rather than
 * generating `王後`.
 */
const ONE_WAY = [
  '後后 發发 髮发 乾干 幹干 隻只 麵面 餘余 臺台 檯台 颱台 鐘钟 鍾钟 準准 徵征 瞭了 麼么 雲云',
  '範范 於于 豐丰 甯宁 寧宁 鬱郁 誌志 註注 託托 諮咨 讚赞 贊赞 歷历 曆历 係系 繫系 緻致 鋪铺',
  '錶表 閑闲 閒闲 闢辟 須须 鬚须 餵喂 饑饥 飢饥 製制 沖冲 衝冲 澱淀 簾帘 籤签 簽签 復复',
  '複复 覆复 獲获 穫获 迴回 樸朴 嶽岳 瀋沈 臟脏 髒脏 鬥斗 蹟迹 跡迹 醜丑 幾几 捲卷 闆板',
].join(' ');

/** Every token is one Traditional and one Simplified BMP character. */
function parse(text, into, both) {
  for (const token of text.split(/\s+/)) {
    if (token.length === 0) continue;
    // Length in UTF-16 units, not code points, and that is the point.
    // matchesAt measures its span as `at + entry.spelling.length`, so a fold
    // that changed the unit count would consume the wrong span and reversal
    // would restore the wrong text. A two-unit token is the invariant.
    if (token.length !== 2) throw new Error(`hanfold: "${token}" is not one Traditional and one Simplified character`);
    const [t, s] = token;
    if (t === s) throw new Error(`hanfold: "${token}" folds a character onto itself`);
    if (into.has(t)) throw new Error(`hanfold: "${t}" appears twice on the Traditional side`);
    into.set(t, s);
    if (!both) continue;
    if (BACK.has(s)) throw new Error(`hanfold: "${s}" appears twice on the Simplified side`);
    BACK.set(s, t);
  }
}

const FORWARD = new Map();
const BACK = new Map();
parse(BIJECTIVE, FORWARD, true);
parse(ONE_WAY, FORWARD, false);
// A one-way Simplified form must never be reachable from the reverse map, or
// the bijection is a bijection in name only. 后 arrives here from 後; if some
// other line had also put it on the Simplified side of a bijective pair, the
// reverse map would carry a guess.
for (const s of FORWARD.values()) {
  const back = BACK.get(s);
  if (back !== undefined && FORWARD.get(back) !== s) {
    throw new Error(`hanfold: "${s}" folds back to a character that does not fold onto it`);
  }
}

/**
 * Simplified characters this table knows to be ambiguous going back.
 *
 * Derived from the table rather than hand-listed, so it cannot drift from it:
 * a Simplified form reachable from FORWARD but absent from BACK is one this
 * file declared one-way. 发 is here (發 and 髮 both fold onto it), and so are
 * 后 干 只 面 余 台 钟 准 制 复.
 *
 * It exists because folding a spelling CHARACTER BY CHARACTER produces a
 * half-folded form as soon as one character has no reverse. `头发` would come
 * back as `頭发`, a spelling nobody writes, and minting needles for words
 * nobody wrote is how a report fills up with rows that mean nothing. So the
 * reverse direction is all or nothing per spelling. Forward needs no such
 * rule: Traditional to Simplified is a total function over this table.
 */
const AMBIGUOUS_BACK = new Set([...FORWARD.values()].filter((s) => !BACK.has(s)));

/** Exported for the selftest, which pins the invariants rather than the size. */
export const foldTable = Object.freeze({ forward: FORWARD, back: BACK, ambiguousBack: AMBIGUOUS_BACK });

// `\p{sc=Han}` cannot tell the two scripts apart, which is what
// docs/architecture-decision.md M3 recorded. It is still the right gate for
// "is there anything here to fold at all": a spelling with no Han in it skips
// two Map walks.
const HAN_RE = /\p{sc=Han}/u;

const EMPTY = Object.freeze([]);

function map(s, table) {
  let out = '';
  for (const ch of s) out += table.get(ch) ?? ch;
  return out;
}

/**
 * The other script's spelling of `s`, in whichever directions are defined.
 *
 * Both directions are attempted because a corpus mixes them: the measurement
 * above found 5.7M Traditional-only and 38.6K Simplified-only characters in
 * ONE corpus. A mixed spelling can therefore yield two forms, and both are
 * real needles.
 *
 * Returns SPELLINGS rather than folding inside the matcher, and the reason is
 * not the one NFC/NFD gives. Han pairs are one UTF-16 unit each, so a matcher
 * fold would keep every span length correct. The reason is that these logs
 * nest JSON inside JSON: a Han character arrives as the six ASCII characters
 * of a `\uXXXX` escape, and residualScan searches `jsonEscaped(spelling)` for
 * exactly that. A character-level fold cannot see hex digits, so it would
 * leave the embedded-JSON form unmatched. As a spelling the twin gets its own
 * escaped form for free, and (the part that mattered) residualScan and
 * probeCounts both sweep `table.entries`, so one addition reaches the
 * substituter, the residue gate and the probe together. The leak happened
 * because the substituter and the scan were wrong together; a fold that
 * reached only one of them would leave the gate lying.
 */
export function hanVariants(s) {
  if (typeof s !== 'string' || s.length === 0 || !HAN_RE.test(s)) return EMPTY;
  const out = new Set();
  // Forward is a total function over the table, so a character it does not
  // know is left alone and the result is still a spelling somebody writes.
  out.add(map(s, FORWARD));
  // Backward is all or nothing: see AMBIGUOUS_BACK.
  let reversible = true;
  for (const ch of s) if (AMBIGUOUS_BACK.has(ch)) reversible = false;
  if (reversible) out.add(map(s, BACK));
  out.delete(s);
  return out.size === 0 ? EMPTY : Object.freeze([...out]);
}
