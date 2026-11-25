'use strict';
/* 一次性补齐语音权限引导词条（5 个，12 语言）：
 * 用户拒绝录音权限（尤其勾了「不再询问」/iOS 拒绝后系统不再弹框）时，
 * composer 弹 showModal 引导去系统设置开启，替代干巴巴的 recordError toast。
 * 纪律：纯文本锚点插入，绝不 JSON.parse→stringify 重建（语言包有历史重复 key，
 * 重建会静默合并丢行）。锚点 = "home.voice.recordError" 行（12 份都有）。
 * 运行：node build/add-voice-permission-keys.cjs（幂等：已存在则跳过该 key）
 */
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'locale');

const T = {
	'zh-Hans': {
		'home.voice.permTitle': '需要麦克风权限',
		'home.voice.permContent': '语音输入需要麦克风权限。请在系统设置中允许 GWork 使用麦克风后重试。',
		'home.voice.permSettings': '去设置',
		'home.voice.permCancel': '取消',
		'home.voice.permDenied': '未获得麦克风权限，语音输入不可用'
	},
	'zh-Hant': {
		'home.voice.permTitle': '需要麥克風權限',
		'home.voice.permContent': '語音輸入需要麥克風權限。請在系統設定中允許 GWork 使用麥克風後重試。',
		'home.voice.permSettings': '前往設定',
		'home.voice.permCancel': '取消',
		'home.voice.permDenied': '未獲得麥克風權限，語音輸入不可用'
	},
	en: {
		'home.voice.permTitle': 'Microphone permission needed',
		'home.voice.permContent': 'Voice input needs microphone access. Allow GWork to use the microphone in system settings, then try again.',
		'home.voice.permSettings': 'Settings',
		'home.voice.permCancel': 'Cancel',
		'home.voice.permDenied': 'Microphone permission not granted; voice input is unavailable'
	},
	de: {
		'home.voice.permTitle': 'Mikrofonberechtigung erforderlich',
		'home.voice.permContent': 'Spracheingabe benötigt Mikrofonzugriff. Erlauben Sie GWork in den Systemeinstellungen die Nutzung des Mikrofons und versuchen Sie es erneut.',
		'home.voice.permSettings': 'Einstellungen',
		'home.voice.permCancel': 'Abbrechen',
		'home.voice.permDenied': 'Mikrofonberechtigung nicht erteilt; Spracheingabe nicht verfügbar'
	},
	ja: {
		'home.voice.permTitle': 'マイクの権限が必要です',
		'home.voice.permContent': '音声入力にはマイクの権限が必要です。システム設定で GWork にマイクの使用を許可してから、もう一度お試しください。',
		'home.voice.permSettings': '設定へ',
		'home.voice.permCancel': 'キャンセル',
		'home.voice.permDenied': 'マイクの権限がないため、音声入力は利用できません'
	},
	ru: {
		'home.voice.permTitle': 'Нужен доступ к микрофону',
		'home.voice.permContent': 'Для голосового ввода нужен доступ к микрофону. Разрешите GWork использовать микрофон в системных настройках и повторите попытку.',
		'home.voice.permSettings': 'Настройки',
		'home.voice.permCancel': 'Отмена',
		'home.voice.permDenied': 'Доступ к микрофону не предоставлен; голосовой ввод недоступен'
	},
	el: {
		'home.voice.permTitle': 'Απαιτείται άδεια μικροφώνου',
		'home.voice.permContent': 'Η φωνητική εισαγωγή απαιτεί πρόσβαση στο μικρόφωνο. Επιτρέψτε στο GWork να χρησιμοποιεί το μικρόφωνο στις ρυθμίσεις συστήματος και δοκιμάστε ξανά.',
		'home.voice.permSettings': 'Ρυθμίσεις',
		'home.voice.permCancel': 'Άκυρο',
		'home.voice.permDenied': 'Δεν δόθηκε άδεια μικροφώνου· η φωνητική εισαγωγή δεν είναι διαθέσιμη'
	},
	es: {
		'home.voice.permTitle': 'Se necesita permiso de micrófono',
		'home.voice.permContent': 'La entrada de voz necesita acceso al micrófono. Permite que GWork use el micrófono en los ajustes del sistema y vuelve a intentarlo.',
		'home.voice.permSettings': 'Ajustes',
		'home.voice.permCancel': 'Cancelar',
		'home.voice.permDenied': 'Permiso de micrófono no concedido; la entrada de voz no está disponible'
	},
	fr: {
		'home.voice.permTitle': 'Autorisation du micro requise',
		'home.voice.permContent': 'La saisie vocale nécessite l\'accès au micro. Autorisez GWork à utiliser le micro dans les réglages système, puis réessayez.',
		'home.voice.permSettings': 'Réglages',
		'home.voice.permCancel': 'Annuler',
		'home.voice.permDenied': 'Autorisation du micro non accordée ; la saisie vocale est indisponible'
	},
	pt: {
		'home.voice.permTitle': 'Permissão de microfone necessária',
		'home.voice.permContent': 'A entrada de voz precisa de acesso ao microfone. Permita que o GWork use o microfone nas configurações do sistema e tente novamente.',
		'home.voice.permSettings': 'Configurações',
		'home.voice.permCancel': 'Cancelar',
		'home.voice.permDenied': 'Permissão de microfone não concedida; a entrada de voz está indisponível'
	},
	ro: {
		'home.voice.permTitle': 'Este necesară permisiunea pentru microfon',
		'home.voice.permContent': 'Introducerea vocală necesită acces la microfon. Permiteți GWork să folosească microfonul în setările sistemului, apoi încercați din nou.',
		'home.voice.permSettings': 'Setări',
		'home.voice.permCancel': 'Anulare',
		'home.voice.permDenied': 'Permisiunea pentru microfon nu a fost acordată; introducerea vocală nu este disponibilă'
	},
	vi: {
		'home.voice.permTitle': 'Cần quyền dùng micrô',
		'home.voice.permContent': 'Nhập liệu bằng giọng nói cần quyền truy cập micrô. Hãy cho phép GWork dùng micrô trong cài đặt hệ thống rồi thử lại.',
		'home.voice.permSettings': 'Cài đặt',
		'home.voice.permCancel': 'Hủy',
		'home.voice.permDenied': 'Chưa được cấp quyền micrô; không thể nhập liệu bằng giọng nói'
	}
};

const ANCHOR = '"home.voice.recordError"';
let changed = 0;
for (const lang of Object.keys(T)) {
	const file = path.join(dir, lang + '.json');
	let src = fs.readFileSync(file, 'utf8');
	const pack = JSON.parse(src); // 只读校验，不回写
	const eol = src.includes('\r\n') ? '\r\n' : '\n';
	const lines = src.split(/\r?\n/);
	const idx = lines.findIndex((l) => l.includes(ANCHOR));
	if (idx === -1) throw new Error(lang + ': anchor home.voice.recordError not found');
	const indent = (lines[idx].match(/^\s*/) || [''])[0];
	const add = [];
	for (const [k, v] of Object.entries(T[lang])) {
		if (k in pack) continue; // 幂等
		add.push(indent + JSON.stringify(k) + ': ' + JSON.stringify(v) + ',');
	}
	if (add.length === 0) { console.log(lang + ': nothing to add'); continue; }
	lines.splice(idx + 1, 0, ...add);
	fs.writeFileSync(file, lines.join(eol), 'utf8');
	JSON.parse(fs.readFileSync(file, 'utf8')); // 回读校验 JSON 合法
	changed++;
	console.log(lang + ': +' + add.length + ' keys');
}
console.log('done, files changed:', changed);