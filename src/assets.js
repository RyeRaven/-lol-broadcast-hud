'use strict';

// Data Dragon 资源层：英雄头像 / 装备 / 召唤师技能图标的 URL 构造、进程内缓存与离线兜底。
// 约束：
// - 纯函数构造 URL，不做任何网络请求；图片由浏览器加载，网络不可用只会触发 onerror；
// - 每个图标底层都先渲染首字母块，<img> 加载失败时被移除，页面不会等待网络、不会抛错；
// - Data Dragon 版本必须是 x.y.z（如 16.22.1），客户端版本号 25.21 之类会被忽略。

const DEFAULT_VERSION = '16.22.1';
const CDN_BASE = 'https://ddragon.leagueoflegends.com/cdn';
// 本地静态头像根：main.js 的 /assets/* 路由从 public/assets 提供文件；
// 头像一律本地优先（离线可用），<img data-cdn> 的 onerror 负责切回 CDN 兜底。
const LOCAL_ICON_BASE = '/assets';

// [中文称号, 中文名, Data Dragon key, 数字 id]
const CHAMPION_TABLE = [["暗裔剑魔","亚托克斯","Aatrox",266],["九尾妖狐","阿狸","Ahri",103],["离群之刺","阿卡丽","Akali",84],["影哨","阿克尚","Akshan",166],["牛头酋长","阿利斯塔","Alistar",12],["铁血狼母","安蓓萨","Ambessa",799],["殇之木乃伊","阿木木","Amumu",32],["冰晶凤凰","艾尼维亚","Anivia",34],["黑暗之女","安妮","Annie",1],["残月之肃","厄斐琉斯","Aphelios",523],["寒冰射手","艾希","Ashe",22],["铸星龙王","奥瑞利安·索尔","AurelionSol",136],["双界灵兔","阿萝拉","Aurora",893],["沙漠皇帝","阿兹尔","Azir",268],["星界游神","巴德","Bard",432],["虚空女皇","卑尔维斯","Belveth",200],["蒸汽机器人","布里茨","Blitzcrank",53],["复仇焰魂","布兰德","Brand",63],["弗雷尔卓德之心","布隆","Braum",201],["狂厄蔷薇","贝蕾亚","Briar",233],["皮城女警","凯特琳","Caitlyn",51],["青钢影","卡蜜尔","Camille",164],["魔蛇之拥","卡西奥佩娅","Cassiopeia",69],["虚空恐惧","科加斯","Chogath",31],["英勇投弹手","库奇","Corki",42],["诺克萨斯之手","德莱厄斯","Darius",122],["皎月女神","黛安娜","Diana",131],["荣耀行刑官","德莱文","Draven",119],["祖安狂人","蒙多医生","DrMundo",36],["时间刺客","艾克","Ekko",245],["蜘蛛女皇","伊莉丝","Elise",60],["痛苦之拥","伊芙琳","Evelynn",28],["探险家","伊泽瑞尔","Ezreal",81],["远古恐惧","费德提克","Fiddlesticks",9],["无双剑姬","菲奥娜","Fiora",114],["潮汐海灵","菲兹","Fizz",105],["正义巨像","加里奥","Galio",3],["海洋之灾","普朗克","Gangplank",41],["德玛西亚之力","盖伦","Garen",86],["迷失之牙","纳尔","Gnar",150],["酒桶","古拉加斯","Gragas",79],["法外狂徒","格雷福斯","Graves",104],["灵罗娃娃","格温","Gwen",887],["战争之影","赫卡里姆","Hecarim",120],["大发明家","黑默丁格","Heimerdinger",74],["异画师","彗","Hwei",910],["海兽祭司","俄洛伊","Illaoi",420],["刀锋舞者","艾瑞莉娅","Irelia",39],["翠神","艾翁","Ivern",427],["风暴之怒","迦娜","Janna",40],["德玛西亚皇子","嘉文四世","JarvanIV",59],["武器大师","贾克斯","Jax",24],["未来守护者","杰斯","Jayce",126],["戏命师","烬","Jhin",202],["暴走萝莉","金克丝","Jinx",222],["虚空之女","卡莎","Kaisa",145],["复仇之矛","卡莉丝塔","Kalista",429],["天启者","卡尔玛","Karma",43],["死亡颂唱者","卡尔萨斯","Karthus",30],["虚空行者","卡萨丁","Kassadin",38],["不祥之刃","卡特琳娜","Katarina",55],["正义天使","凯尔","Kayle",10],["影流之镰","凯隐","Kayn",141],["狂暴之心","凯南","Kennen",85],["虚空掠夺者","卡兹克","Khazix",121],["永猎双子","千珏","Kindred",203],["暴怒骑士","克烈","Kled",240],["深渊巨口","克格莫","KogMaw",96],["纳祖芒荣耀","奎桑提","KSante",897],["诡术妖姬","乐芙兰","Leblanc",7],["盲僧","李青","LeeSin",64],["曙光女神","蕾欧娜","Leona",89],["含羞蓓蕾","莉莉娅","Lillia",876],["冰霜女巫","丽桑卓","Lissandra",127],["灰烬驱魔人","洛克","Locke",805],["圣枪游侠","卢锡安","Lucian",236],["仙灵女巫","璐璐","Lulu",117],["光辉女郎","拉克丝","Lux",99],["熔岩巨兽","墨菲特","Malphite",54],["虚空先知","玛尔扎哈","Malzahar",90],["扭曲树精","茂凯","Maokai",57],["无极剑圣","易","MasterYi",11],["流光镜影","梅尔","Mel",800],["明烛","米利欧","Milio",902],["赏金猎人","厄运小姐","MissFortune",21],["齐天大圣","孙悟空","MonkeyKing",62],["铁铠冥魂","莫德凯撒","Mordekaiser",82],["堕落天使","莫甘娜","Morgana",25],["百裂冥犬","纳亚菲利","Naafiri",950],["唤潮鲛姬","娜美","Nami",267],["沙漠死神","内瑟斯","Nasus",75],["深海泰坦","诺提勒斯","Nautilus",111],["万花通灵","妮蔻","Neeko",518],["狂野女猎手","奈德丽","Nidalee",76],["不羁之悦","尼菈","Nilah",895],["永恒梦魇","魔腾","Nocturne",56],["雪原双子","努努和威朗普","Nunu",20],["狂战士","奥拉夫","Olaf",2],["发条魔灵","奥莉安娜","Orianna",61],["山隐之焰","奥恩","Ornn",516],["不屈之枪","潘森","Pantheon",80],["圣锤之毅","波比","Poppy",78],["血港鬼影","派克","Pyke",555],["元素女皇","奇亚娜","Qiyana",246],["德玛西亚之翼","奎因","Quinn",133],["幻翎","洛","Rakan",497],["披甲龙龟","拉莫斯","Rammus",33],["虚空遁地兽","雷克塞","RekSai",421],["镕铁少女","芮尔","Rell",526],["炼金男爵","烈娜塔 · 戈拉斯克","Renata",888],["荒漠屠夫","雷克顿","Renekton",58],["傲之追猎者","雷恩加尔","Rengar",107],["放逐之刃","锐雯","Riven",92],["机械公敌","兰博","Rumble",68],["符文法师","瑞兹","Ryze",13],["沙漠玫瑰","莎弥拉","Samira",360],["北地之怒","瑟庄妮","Sejuani",113],["涤魂圣枪","赛娜","Senna",235],["星籁歌姬","萨勒芬妮","Seraphine",147],["腕豪","瑟提","Sett",875],["恶魔小丑","萨科","Shaco",35],["暮光之眼","慎","Shen",98],["龙血武姬","希瓦娜","Shyvana",102],["炼金术士","辛吉德","Singed",27],["亡灵战神","赛恩","Sion",14],["战争女神","希维尔","Sivir",15],["上古领主","斯卡纳","Skarner",72],["炽炎雏龙","斯莫德","Smolder",901],["琴瑟仙女","娑娜","Sona",37],["众星之子","索拉卡","Soraka",16],["诺克萨斯统领","斯维因","Swain",50],["解脱者","塞拉斯","Sylas",517],["暗黑元首","辛德拉","Syndra",134],["河流之王","塔姆","TahmKench",223],["岩雀","塔莉垭","Taliyah",163],["刀锋之影","泰隆","Talon",91],["瓦洛兰之盾","塔里克","Taric",44],["迅捷斥候","提莫","Teemo",17],["魂锁典狱长","锤石","Thresh",412],["麦林炮手","崔丝塔娜","Tristana",18],["巨魔之王","特朗德尔","Trundle",48],["蛮族之王","泰达米尔","Tryndamere",23],["卡牌大师","崔斯特","TwistedFate",4],["瘟疫之源","图奇","Twitch",29],["兽灵行者","乌迪尔","Udyr",77],["无畏战车","厄加特","Urgot",6],["惩戒之箭","韦鲁斯","Varus",110],["暗夜猎手","薇恩","Vayne",67],["邪恶小法师","维迦","Veigar",45],["虚空之眼","维克兹","Velkoz",161],["愁云使者","薇古丝","Vex",711],["皮城执法官","蔚","Vi",254],["破败之王","佛耶戈","Viego",234],["奥术先驱","维克托","Viktor",112],["猩红收割者","弗拉基米尔","Vladimir",8],["不灭狂雷","沃利贝尔","Volibear",106],["祖安怒兽","沃里克","Warwick",19],["逆羽","霞","Xayah",498],["远古巫灵","泽拉斯","Xerath",101],["德邦总管","赵信","XinZhao",5],["疾风剑豪","亚索","Yasuo",157],["封魔剑魂","永恩","Yone",777],["牧魂人","约里克","Yorick",83],["不破之誓","芸阿娜","Yunara",804],["魔法猫咪","悠米","Yuumi",350],["不落魔锋","亚恒","Zaahen",904],["生化魔人","扎克","Zac",154],["影流之主","劫","Zed",238],["祖安花火","泽丽","Zeri",221],["爆破鬼才","吉格斯","Ziggs",115],["时光守护者","基兰","Zilean",26],["暮光星灵","佐伊","Zoe",142],["荆棘之兴","婕拉","Zyra",143]];
// [物品中文名, 数字 id]，召唤师峡谷可购买装备（用于把 Live Client Data 的装备名转成图标）
const ITEM_TABLE = [["黯炎火炬",2503],["黯影阔剑",3179],["霸王血铠",2501],["败魔",2504],["班德尔玻璃镜",4642],["班德尔音管",2524],["斑比的熔渣",6660],["暴风之剑",1038],["暴食胫甲",3008],["爆裂魔杖",1026],["冰川圆盾",3024],["冰脉护手",6662],["冰霜之心",3110],["不朽盾弓",6673],["不朽之路",3168],["布甲",1029],["残暴之力",2020],["残疫",3118],["草间人",3330],["斥候弹弓",3144],["炽热香炉",3504],["璀璨回响",6664],["萃取",1083],["翠绿屏障",4632],["大天使之杖",3003],["带链碾碎者",3173],["带翼的月板甲",3066],["帝国指令",4005],["电震涡流剑",6699],["短剑",1042],["多兰之盾",1054],["多兰之弓",1086],["多兰之戒",1056],["多兰之盔",1120],["多兰之刃",1055],["多米尼克领主的致意",3036],["夺萃之镰",3508],["恶魔法典",3108],["耳语头环",2526],["法师之靴",3020],["凡性的提醒",3033],["反曲之弓",1043],["放血者的诅咒",8010],["焚天",6610],["愤怒合剂",2140],["风暴狂涌",4646],["风行狐幼体",1102],["负极斗篷",1057],["复用型药水",2031],["缚炉之斧",3051],["钢铁合剂",2138],["钢铁烈阳之匣",3190],["钢铁印章",2019],["公理圆弧",6696],["鬼索的狂暴之刃",3124],["海克斯镜片 C44",2523],["海克斯科技发电机",3145],["海克斯科技火箭腰带",3152],["海克斯科技枪刃",3146],["海克斯饮魔刀",3155],["海克斯注力刚壁",3073],["海力亚的回响",6620],["海妖杀手",6672],["黑暗封印",1082],["黑色切割者",3071],["红水晶",1028],["幻影之舞",3046],["黄昏与黎明",2510],["基克的聚合",2055],["疾射火炮",3094],["棘刺背心",3076],["剑翎",6690],["界弓",3302],["禁忌雕像",3114],["荆棘之甲",3075],["晶体护腕",3801],["净蚀",3044],["救赎",3107],["巨人腰带",1011],["巨蛇之牙",6695],["巨型九头蛇",3748],["锯齿短匕",3134],["掘道钻头",2021],["卡莉丝塔的黑色长矛",3599],["抗魔斗篷",1033],["考尔菲德的战锤",3133],["控制守卫",2055],["枯萎珠宝",4630],["狂热",3086],["狂徒铠甲",3083],["狂妄",6697],["狂战士胫甲",3006],["兰德里的折磨",6653],["兰顿之兆",3143],["岚切",3095],["蓝水晶",1027],["黎明核心",6621],["炼金朋克链锯剑",6609],["猎魔人弩箭",2512],["裂隙制造者",4633],["凛冬之临",3119],["灵能使之靴",3175],["灵巧披风",1018],["流水法杖",6616],["卢安娜的飓风",3085],["卢登的回声",6655],["玛莫提乌斯之噬",3156],["帽子饮品",2141],["梅贾的窃魂卷",3041],["米凯尔的祝福",3222],["灭世者的死亡之帽",3089],["明朗之靴",3158],["命定灰烬",2508],["摩天雪橇",3876],["魔宗",3004],["莫雷洛秘典",3165],["纳什之牙",3115],["纳沃利烁刃",6675],["女神之泪",3070],["女妖面纱",3102],["炮铜胫甲",3172],["破败王者之刃",3153],["破舰者",3181],["破垒者",2520],["骑士之誓",3109],["千变者贾修",6665],["轻灵之靴",3009],["燃烧宝石",3067],["日炎圣盾",3068],["瑞莱的冰晶节杖",3116],["赛瑞尔达的怨恨",6694],["三相之力",3078],["深渊面具",8020],["神谕透镜",3364],["生命药水",2003],["十字镐",1037],["时光之杖",6657],["实现器",2522],["视界专注",4628],["收集者",6676],["守护天使",3026],["守护者法球",3112],["守护者号角",2051],["守护者战锤",3184],["守护者之刃",3177],["守望者铠甲",3082],["舒瑞娅的战歌",2065],["水银饰带",3140],["水银弯刀",3139],["水银之靴",3111],["朔极之矛",3161],["斯塔缇克电刃",3087],["斯特拉克的挑战护手",3053],["死亡之舞",6333],["死刑宣告",3123],["碎裂的护臂",2421],["锁子甲",1031],["踏苔蜥幼苗",1103],["贪欲九头蛇",3074],["探索者的护臂",2420],["提亚马特",3077],["铁板靴",3047],["挺进破坏者",6631],["蜕生",3137],["万世催化石",3803],["亡者的板甲",3742],["巫术合剂",2139],["巫妖之祸",3100],["无尽之刃",3031],["无穷饥渴",2517],["无用大棒",1058],["无终恨意",2502],["吸血鬼节杖",1053],["仙女护符",1004],["鞋子",1001],["亵渎九头蛇",6698],["心之钢",3084],["星界据守",3869],["星界驱驰",4629],["星蚀",6692],["猩红明朗",3171],["虚空之杖",3135],["血鸣",3877],["迅速进军",3170],["湮灭宝珠",3916],["焰爪猫幼崽",1101],["耀光",3057],["夜之锋刃",3814],["遗失的章节",3802],["以太精魂",3113],["饮血剑",3072],["荧尘",2022],["影焰",4645],["幽魂斗篷",3211],["幽魂面具",3147],["幽梦之灵",3142],["育恩塔尔荒野箭",3032],["原生质护带",2525],["圆梦使者",3870],["远见改造",3363],["月石再生器",6617],["云游图鉴",3865],["增幅典籍",1052],["扎兹沙克的溃口",3871],["长剑",1036],["侦察守卫",3340],["振奋盔甲",3065],["正午箭袋",6670],["治疗宝珠",1006],["智慧末刃",3091],["中娅沙漏",3157],["装甲战靴",3174],["自然之力",4401],["最后的轻语",3035]];

// 召唤师技能中文名 → Data Dragon key（官方名称 + 常用别名）。
const SPELL_TABLE = [
  ['屏障', 'SummonerBarrier'], ['净化', 'SummonerBoost'], ['闪现', 'SummonerFlash'],
  ['引燃', 'SummonerDot'], ['虚弱', 'SummonerExhaust'], ['幽灵疾步', 'SummonerHaste'],
  ['治疗术', 'SummonerHeal'], ['清晰术', 'SummonerMana'], ['惩戒', 'SummonerSmite'],
  ['传送', 'SummonerTeleport'], ['标记', 'SummonerSnowball'], ['护驾', 'SummonerPoroRecall'],
  ['魄罗投掷', 'SummonerPoroThrow'], ['占位', 'Summoner_UltBookPlaceholder']
];

// 短名/昵称兜底：官方称号之外，玩家与 mock 数据常用的简称。
const CHAMPION_NICKNAMES = {
  '泰坦': 'Nautilus', '鳄鱼': 'Renekton', '瞎子': 'LeeSin', '盲僧': 'LeeSin', '卡莎': 'Kaisa',
  '好运姐': 'MissFortune', '女枪': 'MissFortune', '男枪': 'Graves', '发条': 'Orianna',
  '球女': 'Syndra', '石头人': 'Malphite', '木木': 'Amumu', '猴子': 'MonkeyKing',
  '诺手': 'Darius', '德玛': 'Garen', '寒冰': 'Ashe', '薇恩': 'Vayne', '小炮': 'Tristana',
  '大嘴': 'KogMaw', '老鼠': 'Twitch', '寡妇': 'Evelynn', '蜘蛛': 'Elise', '豹女': 'Nidalee',
  '螳螂': 'Khazix', '狮子狗': 'Rengar', '剑圣': 'MasterYi', '蛮王': 'Tryndamere',
  '武器': 'Jax', '剑姬': 'Fiora', '锐雯': 'Riven', '瑞文': 'Riven', '刀妹': 'Irelia',
  '卡特': 'Katarina', '阿卡丽': 'Akali', '狐狸': 'Ahri', '光辉': 'Lux', '莫甘娜': 'Morgana',
  '天使': 'Kayle', '慎': 'Shen', '肾': 'Shen', '潘森': 'Pantheon', '船长': 'Gangplank',
  '男刀': 'Talon', '劫': 'Zed', '金克丝': 'Jinx', '女警': 'Caitlyn', '皮城': 'Caitlyn',
  '奥巴马': 'Lucian', '小丑': 'Shaco', '大虫子': 'Chogath', '虫子': 'Chogath',
  '猪妹': 'Sejuani', '酒桶': 'Gragas', '皇子': 'JarvanIV', 'ez': 'Ezreal', 'vn': 'Vayne'
};

// 演示用装备组合：mock 数据的装备是占位符号，渲染时替换成真实装备图标。
// 第 7 位 = 视野饰品（3340 假眼 / 3363 蓝眼 / 3364 扫描），原生记分板每人都是 6 装备 + 1 饰品。
const DEMO_ITEM_SETS = [
  [1055, 3047, 6333, 3053, 3143, 3078, 3340],
  [1101, 3111, 3068, 3053, 3143, 3065, 3364],
  [1056, 3020, 3157, 3089, 3135, 3165, 3363],
  [1055, 3006, 6672, 3031, 3094, 3036, 3340],
  [1056, 3111, 3190, 3222, 3109, 3050, 3363],
  [1054, 3111, 3078, 3053, 3065, 3143, 3340],
  [1102, 3047, 6333, 3071, 3053, 3068, 3364],
  [1056, 3020, 3157, 3089, 3165, 3135, 3363],
  [1055, 3006, 6672, 3031, 3094, 3036, 3340],
  [1056, 3111, 3222, 3190, 3109, 3050, 3363]
];

const championByAlias = new Map();
const championById = new Map();
for (const [title, name, key, id] of CHAMPION_TABLE) {
  championById.set(Number(id), key);
  for (const alias of [title, name, key]) {
    const raw = String(alias || '').trim();
    if (!raw) continue;
    championByAlias.set(raw.toLowerCase(), key);
    championByAlias.set(raw.replace(/[\s'’.·-]/g, '').toLowerCase(), key);
  }
}
for (const [alias, key] of Object.entries(CHAMPION_NICKNAMES)) championByAlias.set(alias.toLowerCase(), key);
const itemByName = new Map();
for (const [name, id] of ITEM_TABLE) {
  itemByName.set(String(name), id);
  itemByName.set(String(name).replace(/\s+/g, ''), id);
}
const spellByName = new Map();
for (const [name, key] of SPELL_TABLE) {
  spellByName.set(String(name), key);
  spellByName.set(String(name).toLowerCase(), key);
  spellByName.set(String(key).toLowerCase(), key);
}

const urlCache = new Map();

function normalizeVersion(version) {
  const value = String(version == null ? '' : version).trim();
  return /^\d+\.\d+\.\d+$/.test(value) ? value : DEFAULT_VERSION;
}

function championKey(champion) {
  if (champion === null || champion === undefined) return '';
  const raw = String(champion).trim();
  if (!raw) return '';
  if (/^\d+$/.test(raw)) return championById.get(Number(raw)) || '';
  const lower = raw.toLowerCase();
  if (championByAlias.has(lower)) return championByAlias.get(lower);
  const compact = raw.replace(/[\s'’.·-]/g, '').toLowerCase();
  if (championByAlias.has(compact)) return championByAlias.get(compact);
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(raw.replace(/[\s'’.·-]/g, ''))) return raw.replace(/[\s'’.·-]/g, '');
  return '';
}

function itemId(item) {
  if (item === null || item === undefined) return null;
  const raw = String(item).trim();
  if (!raw) return null;
  const hash = raw.match(/^#(\d+)$/);
  if (hash) return Number(hash[1]);
  if (/^\d+$/.test(raw)) return Number(raw);
  if (itemByName.has(raw)) return itemByName.get(raw);
  const compact = raw.replace(/\s+/g, '');
  if (itemByName.has(compact)) return itemByName.get(compact);
  return null;
}

function spellKey(spell) {
  if (spell === null || spell === undefined) return '';
  const raw = String(spell).trim();
  if (!raw) return '';
  if (spellByName.has(raw)) return spellByName.get(raw);
  if (spellByName.has(raw.toLowerCase())) return spellByName.get(raw.toLowerCase());
  if (/^Summoner[A-Za-z0-9_]+$/.test(raw)) return raw;
  return '';
}

function cachedUrl(key, build) {
  if (urlCache.has(key)) return urlCache.get(key);
  const value = build();
  urlCache.set(key, value);
  return value;
}

function championIconUrl(champion, version) {
  const key = championKey(champion);
  if (!key) return '';
  const v = normalizeVersion(version);
  return cachedUrl('champion|' + v + '|' + key, () => LOCAL_ICON_BASE + '/champion/' + key + '.png');
}

// CDN 原始地址：本地头像缺失时由 <img data-cdn> 的 onerror 兜底切换。
function championCdnUrl(champion, version) {
  const key = championKey(champion);
  if (!key) return '';
  const v = normalizeVersion(version);
  return cachedUrl('champion-cdn|' + v + '|' + key, () => CDN_BASE + '/' + v + '/img/champion/' + key + '.png');
}

function itemIconUrl(item, version) {
  const id = itemId(item);
  if (id === null) return '';
  const v = normalizeVersion(version);
  return cachedUrl('item|' + v + '|' + id, () => CDN_BASE + '/' + v + '/img/item/' + id + '.png');
}

function spellIconUrl(spell, version) {
  const key = spellKey(spell);
  if (!key) return '';
  const v = normalizeVersion(version);
  return cachedUrl('spell|' + v + '|' + key, () => CDN_BASE + '/' + v + '/img/spell/' + key + '.png');
}

// BP / 大字报使用的高清原画（loading splash）；离线时元素底部的队伍色渐变作为兜底。
function championSplashUrl(champion, version) {
  const key = championKey(champion);
  if (!key) return '';
  normalizeVersion(version);
  return cachedUrl('splash|' + key, () => CDN_BASE + '/img/champion/splash/' + key + '_0.jpg');
}

function championCenteredSplashUrl(champion) {
  const raw = champion === null || champion === undefined ? '' : String(champion).trim();
  if (!raw) return '';
  let id = 0;
  if (/^\d+$/.test(raw)) id = Number(raw);
  else {
    const key = championKey(raw);
    const row = CHAMPION_TABLE.find(entry => entry[2] === key);
    if (row) id = row[3];
  }
  if (!id) return '';
  // 本地缓存路由（main.js /api/splash/<id>）：磁盘有直接回，没有 302 CDN 并后台落盘。
  return cachedUrl('splash-centered|' + id, () => '/api/splash/' + id);
}


function iconUrl(kind, value, version) {
  if (kind === 'champion') return championIconUrl(value, version);
  if (kind === 'item') return itemIconUrl(value, version);
  if (kind === 'spell') return spellIconUrl(value, version);
  return '';
}

function fallbackInitial(label) {
  const text = String(label == null ? '' : label).trim();
  if (!text) return '?';
  const first = Array.from(text)[0];
  return /[a-z]/.test(first) ? first.toUpperCase() : first;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function iconMarkup(kind, value, options = {}) {
  const label = options.label == null ? String(value == null ? '' : value) : String(options.label);
  const className = ['icon', kind + '-icon', options.className || ''].filter(Boolean).join(' ');
  const title = options.title ? ' title="' + escapeHtml(options.title) + '"' : '';
  const fallback = '<i class="icon-fb" aria-hidden="true">' + escapeHtml(fallbackInitial(label)) + '</i>';
  const url = iconUrl(kind, value, options.version);
  if (!url) return '<span class="' + className + '"' + title + '>' + fallback + '</span>';
  const cdn = kind === 'champion' ? championCdnUrl(value, options.version) : '';
  const fallbackAttr = cdn ? ' data-cdn="' + escapeHtml(cdn) + '"' : '';
  const onError = cdn ? "if(this.dataset.cdn){this.src=this.dataset.cdn;this.removeAttribute('data-cdn');}else{this.remove();}" : 'this.remove()';
  return '<span class="' + className + '"' + title + '>' + fallback +
    '<img src="' + escapeHtml(url) + '"' + fallbackAttr + ' alt="' + escapeHtml(label) + '" loading="lazy" onerror="' + onError + '">' +
    '</span>';
}

function assetCacheSize() { return urlCache.size; }
function clearAssetCache() { urlCache.clear(); }

// 生成浏览器端同一套解析逻辑（数据表随页面内联，避免额外请求）。
function clientScript() {
  const payload = JSON.stringify({
    version: DEFAULT_VERSION,
    champions: CHAMPION_TABLE,
    items: ITEM_TABLE,
    spells: SPELL_TABLE,
    nicknames: CHAMPION_NICKNAMES,
    demoItems: DEMO_ITEM_SETS
  });
  // 挂到全局而不是硬编码 window：测试里用 vm 跑这段脚本时没有 window，会直接 ReferenceError。
  return String.raw`(typeof window !== 'undefined' ? window : globalThis).RBAssets = (function () {
  var DATA = ${payload};
  var championByAlias = new Map();
  var championById = new Map();
  for (var i = 0; i < DATA.champions.length; i += 1) {
    var row = DATA.champions[i];
    championById.set(Number(row[3]), row[2]);
    var aliases = [row[0], row[1], row[2]];
    for (var j = 0; j < aliases.length; j += 1) {
      var raw = String(aliases[j] || '').trim();
      if (!raw) continue;
      championByAlias.set(raw.toLowerCase(), row[2]);
      championByAlias.set(raw.replace(/[\s'’.·-]/g, '').toLowerCase(), row[2]);
    }
  }
  Object.keys(DATA.nicknames).forEach(function (alias) { championByAlias.set(alias.toLowerCase(), DATA.nicknames[alias]); });
  var itemByName = new Map();
  for (var k = 0; k < DATA.items.length; k += 1) {
    itemByName.set(String(DATA.items[k][0]), DATA.items[k][1]);
    itemByName.set(String(DATA.items[k][0]).replace(/\s+/g, ''), DATA.items[k][1]);
  }
  var spellByName = new Map();
  for (var n = 0; n < DATA.spells.length; n += 1) {
    spellByName.set(String(DATA.spells[n][0]), DATA.spells[n][1]);
    spellByName.set(String(DATA.spells[n][0]).toLowerCase(), DATA.spells[n][1]);
    spellByName.set(String(DATA.spells[n][1]).toLowerCase(), DATA.spells[n][1]);
  }
  var cache = new Map();
  function normalizeVersion(version) {
    var value = String(version == null ? '' : version).trim();
    return /^\d+\.\d+\.\d+$/.test(value) ? value : DATA.version;
  }
  function championKey(champion) {
    if (champion === null || champion === undefined) return '';
    var raw = String(champion).trim();
    if (!raw) return '';
    if (/^\d+$/.test(raw)) return championById.get(Number(raw)) || '';
    var lower = raw.toLowerCase();
    if (championByAlias.has(lower)) return championByAlias.get(lower);
    var compact = raw.replace(/[\s'’.·-]/g, '').toLowerCase();
    if (championByAlias.has(compact)) return championByAlias.get(compact);
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(raw.replace(/[\s'’.·-]/g, ''))) return raw.replace(/[\s'’.·-]/g, '');
    return '';
  }
  function itemId(item) {
    if (item === null || item === undefined) return null;
    var raw = String(item).trim();
    if (!raw) return null;
    var hash = raw.match(/^#(\d+)$/);
    if (hash) return Number(hash[1]);
    if (/^\d+$/.test(raw)) return Number(raw);
    if (itemByName.has(raw)) return itemByName.get(raw);
    var compact = raw.replace(/\s+/g, '');
    if (itemByName.has(compact)) return itemByName.get(compact);
    return null;
  }
  function spellKey(spell) {
    if (spell === null || spell === undefined) return '';
    var raw = String(spell).trim();
    if (!raw) return '';
    if (spellByName.has(raw)) return spellByName.get(raw);
    if (spellByName.has(raw.toLowerCase())) return spellByName.get(raw.toLowerCase());
    if (/^Summoner[A-Za-z0-9_]+$/.test(raw)) return raw;
    return '';
  }
  function cached(key, build) {
    if (cache.has(key)) return cache.get(key);
    var value = build();
    cache.set(key, value);
    return value;
  }
  function championIconUrl(champion, version) {
    var key = championKey(champion);
    if (!key) return '';
    var v = normalizeVersion(version);
    return cached('champion|' + v + '|' + key, function () { return '/assets/champion/' + key + '.png'; });
  }
  function championCdnUrl(champion, version) {
    var key = championKey(champion);
    if (!key) return '';
    var v = normalizeVersion(version);
    return cached('champion-cdn|' + v + '|' + key, function () { return 'https://ddragon.leagueoflegends.com/cdn/' + v + '/img/champion/' + key + '.png'; });
  }
  function itemIconUrl(item, version) {
    var id = itemId(item);
    if (id === null) return '';
    var v = normalizeVersion(version);
    return cached('item|' + v + '|' + id, function () { return 'https://ddragon.leagueoflegends.com/cdn/' + v + '/img/item/' + id + '.png'; });
  }
  function spellIconUrl(spell, version) {
    var key = spellKey(spell);
    if (!key) return '';
    var v = normalizeVersion(version);
    return cached('spell|' + v + '|' + key, function () { return 'https://ddragon.leagueoflegends.com/cdn/' + v + '/img/spell/' + key + '.png'; });
  }
  function championSplashUrl(champion, version) {
    var key = championKey(champion);
    if (!key) return '';
    normalizeVersion(version);
    return cached('splash|' + key, function () { return 'https://ddragon.leagueoflegends.com/cdn/img/champion/splash/' + key + '_0.jpg'; });
  }
  function championCenteredSplashUrl(champion) {
    var raw = champion === null || champion === undefined ? '' : String(champion).trim();
    if (!raw) return '';
    var id = 0;
    if (/^\d+$/.test(raw)) id = Number(raw);
    else {
      var key = championKey(raw);
      for (var i = 0; i < DATA.champions.length; i += 1) {
        if (DATA.champions[i][2] === key) { id = DATA.champions[i][3]; break; }
      }
    }
    if (!id) return '';
    // 本地缓存路由（main.js /api/splash/<id>）：磁盘有直接回，没有 302 CDN 并后台落盘。
    return cached('splash-centered|' + id, function () { return '/api/splash/' + id; });
  }

  function fallbackInitial(label) {
    var text = String(label == null ? '' : label).trim();
    if (!text) return '?';
    var chars = Array.from(text);
    var first = chars[0];
    return /[a-z]/.test(first) ? first.toUpperCase() : first;
  }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function icon(kind, value, label, className, version) {
    var text = label == null ? String(value == null ? '' : value) : String(label);
    var url = kind === 'champion' ? championIconUrl(value, version) : kind === 'item' ? itemIconUrl(value, version) : kind === 'spell' ? spellIconUrl(value, version) : '';
    var cls = 'icon ' + kind + '-icon' + (className ? ' ' + className : '');
    var fallback = '<i class="icon-fb" aria-hidden="true">' + escapeHtml(fallbackInitial(text)) + '</i>';
    if (!url) return '<span class="' + cls + '">' + fallback + '</span>';
    var cdn = kind === 'champion' ? championCdnUrl(value, version) : '';
    var fbAttr = cdn ? ' data-cdn="' + escapeHtml(cdn) + '"' : '';
    var onError = cdn ? "if(this.dataset.cdn){this.src=this.dataset.cdn;this.removeAttribute('data-cdn');}else{this.remove();}" : 'this.remove()';
    return '<span class="' + cls + '">' + fallback + '<img src="' + escapeHtml(url) + '"' + fbAttr + ' alt="' + escapeHtml(text) + '" loading="lazy" onerror="' + onError + '">' + '</span>';
  }
  return {
    version: DATA.version,
    normalizeVersion: normalizeVersion,
    championKey: championKey,
    itemId: itemId,
    spellKey: spellKey,
    championIconUrl: championIconUrl,
    itemIconUrl: itemIconUrl,
    spellIconUrl: spellIconUrl,
    championSplashUrl: championSplashUrl,
    championCenteredSplashUrl: championCenteredSplashUrl,
    fallbackInitial: fallbackInitial,
    icon: icon,
    demoItems: DATA.demoItems
  };
})();`;
}

module.exports = {
  DEFAULT_VERSION,
  CHAMPION_TABLE,
  ITEM_TABLE,
  SPELL_TABLE,
  DEMO_ITEM_SETS,
  normalizeVersion,
  championKey,
  itemId,
  spellKey,
  championIconUrl,
  championCdnUrl,
  itemIconUrl,
  spellIconUrl,
  championSplashUrl,
  championCenteredSplashUrl,
  iconUrl,
  fallbackInitial,
  iconMarkup,
  assetCacheSize,
  clearAssetCache,
  clientScript
};
