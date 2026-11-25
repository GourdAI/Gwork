// 一次性脚本：为「允许完全访问」二次确认弹窗补 4 个 key × 12 语种。
// 用法：node build/add-permission-confirm-keys.cjs（幂等：已存在则跳过）
const fs = require('fs');
const path = require('path');
const add = {
	'zh-Hans': {
		'home.permission.confirmTitle': '确认允许完全访问？',
		'home.permission.confirmBody': '允许完全访问后，所有任务将减少确认步骤并直接操作您的电脑（包括敏感操作、文件修改和外部执行），请谨慎操作。仅建议您信任当前任务时允许完全访问。',
		'home.permission.confirmOk': '允许完全访问',
		'home.permission.confirmCancel': '取消'
	},
	'zh-Hant': {
		'home.permission.confirmTitle': '確認允許完全存取？',
		'home.permission.confirmBody': '允許完全存取後，所有任務將減少確認步驟並直接操作您的電腦（包括敏感操作、檔案修改和外部執行），請謹慎操作。僅建議您信任目前任務時允許完全存取。',
		'home.permission.confirmOk': '允許完全存取',
		'home.permission.confirmCancel': '取消'
	},
	en: {
		'home.permission.confirmTitle': 'Allow full access?',
		'home.permission.confirmBody': 'With full access, tasks skip most confirmations and operate your computer directly (including sensitive actions, file changes and external execution). Proceed with care — only grant full access for tasks you trust.',
		'home.permission.confirmOk': 'Allow full access',
		'home.permission.confirmCancel': 'Cancel'
	},
	de: {
		'home.permission.confirmTitle': 'Vollzugriff erlauben?',
		'home.permission.confirmBody': 'Mit Vollzugriff überspringen Aufgaben die meisten Bestätigungen und arbeiten direkt auf Ihrem Computer (einschließlich sensibler Aktionen, Dateiänderungen und externer Ausführung). Bitte vorsichtig vorgehen — nur für Aufgaben gewähren, denen Sie vertrauen.',
		'home.permission.confirmOk': 'Vollzugriff erlauben',
		'home.permission.confirmCancel': 'Abbrechen'
	},
	es: {
		'home.permission.confirmTitle': '¿Permitir acceso total?',
		'home.permission.confirmBody': 'Con acceso total, las tareas omiten la mayoría de confirmaciones y operan su ordenador directamente (incluidas acciones sensibles, cambios de archivos y ejecución externa). Proceda con cuidado: conceda acceso total solo a tareas de confianza.',
		'home.permission.confirmOk': 'Permitir acceso total',
		'home.permission.confirmCancel': 'Cancelar'
	},
	fr: {
		'home.permission.confirmTitle': "Autoriser l'accès complet ?",
		'home.permission.confirmBody': "Avec l'accès complet, les tâches ignorent la plupart des confirmations et agissent directement sur votre ordinateur (actions sensibles, modifications de fichiers et exécutions externes incluses). Soyez prudent : n'accordez l'accès complet qu'aux tâches de confiance.",
		'home.permission.confirmOk': "Autoriser l'accès complet",
		'home.permission.confirmCancel': 'Annuler'
	},
	ja: {
		'home.permission.confirmTitle': 'フルアクセスを許可しますか？',
		'home.permission.confirmBody': 'フルアクセスを許可すると、タスクは確認をほとんど省略し、PC を直接操作します（機微な操作、ファイル変更、外部実行を含む）。慎重に操作し、信頼できるタスクにのみ許可してください。',
		'home.permission.confirmOk': 'フルアクセスを許可',
		'home.permission.confirmCancel': 'キャンセル'
	},
	pt: {
		'home.permission.confirmTitle': 'Permitir acesso total?',
		'home.permission.confirmBody': 'Com acesso total, as tarefas ignoram a maioria das confirmações e operam seu computador diretamente (incluindo ações sensíveis, alterações de arquivos e execução externa). Prossiga com cuidado — conceda acesso total apenas a tarefas confiáveis.',
		'home.permission.confirmOk': 'Permitir acesso total',
		'home.permission.confirmCancel': 'Cancelar'
	},
	ru: {
		'home.permission.confirmTitle': 'Разрешить полный доступ?',
		'home.permission.confirmBody': 'С полным доступом задачи пропускают большинство подтверждений и напрямую управляют вашим компьютером (включая чувствительные действия, изменение файлов и внешнее выполнение). Будьте осторожны — предоставляйте полный доступ только доверенным задачам.',
		'home.permission.confirmOk': 'Разрешить полный доступ',
		'home.permission.confirmCancel': 'Отмена'
	},
	el: {
		'home.permission.confirmTitle': 'Να επιτραπεί πλήρης πρόσβαση;',
		'home.permission.confirmBody': 'Με πλήρη πρόσβαση, οι εργασίες παραλείπουν τις περισσότερες επιβεβαιώσεις και λειτουργούν απευθείας στον υπολογιστή σας (συμπεριλαμβανομένων ευαίσθητων ενεργειών, αλλαγών αρχείων και εξωτερικής εκτέλεσης). Προχωρήστε προσεκτικά — δώστε πλήρη πρόσβαση μόνο σε εργασίες που εμπιστεύεστε.',
		'home.permission.confirmOk': 'Πλήρης πρόσβαση',
		'home.permission.confirmCancel': 'Άκυρο'
	},
	ro: {
		'home.permission.confirmTitle': 'Permiteți accesul complet?',
		'home.permission.confirmBody': 'Cu acces complet, sarcinile sar peste majoritatea confirmărilor și operează direct computerul dvs. (inclusiv acțiuni sensibile, modificări de fișiere și execuție externă). Procedați cu grijă — acordați acces complet doar sarcinilor de încredere.',
		'home.permission.confirmOk': 'Permiteți accesul complet',
		'home.permission.confirmCancel': 'Anulare'
	},
	vi: {
		'home.permission.confirmTitle': 'Cho phép toàn quyền truy cập?',
		'home.permission.confirmBody': 'Khi có toàn quyền truy cập, các tác vụ sẽ bỏ qua hầu hết bước xác nhận và trực tiếp thao tác máy tính của bạn (gồm thao tác nhạy cảm, sửa tệp và thực thi bên ngoài). Hãy thận trọng — chỉ cấp toàn quyền cho tác vụ bạn tin tưởng.',
		'home.permission.confirmOk': 'Cho phép toàn quyền',
		'home.permission.confirmCancel': 'Hủy'
	}
};
for (const [lang, kv] of Object.entries(add)) {
	const f = path.join(__dirname, '..', 'locale', lang + '.json');
	const p = JSON.parse(fs.readFileSync(f, 'utf8'));
	let n = 0;
	for (const [k, v] of Object.entries(kv)) {
		if (k in p) continue;
		p[k] = v;
		n++;
	}
	fs.writeFileSync(f, JSON.stringify(p, null, '\t') + '\n');
	console.log(lang + ' +' + n);
}