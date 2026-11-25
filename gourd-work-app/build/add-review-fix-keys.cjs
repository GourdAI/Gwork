'use strict';
/* 一次性脚本：codereview 修复轮新增词条 ×12 + 删除死 key home.run.permissionHint。
 * 运行后自检键集对称；脚本保留作变更记录。 */
const fs = require('node:fs');
const path = require('node:path');

const ADD = {
    'home.run.permDefault': {
        'zh-Hans': '默认权限', 'zh-Hant': '預設權限', en: 'Default access',
        ja: 'デフォルト権限', ru: 'Обычный доступ', de: 'Standardzugriff',
        el: 'Προεπιλεγμένη πρόσβαση', es: 'Acceso predeterminado', fr: 'Accès par défaut',
        pt: 'Acesso padrão', ro: 'Acces implicit', vi: 'Quyền mặc định'
    },
    'home.run.permDefaultDesc': {
        'zh-Hans': '仅可访问当前工作空间内的文件', 'zh-Hant': '僅可存取目前工作空間內的檔案',
        en: 'Only files inside the current workspace', ja: '現在のワークスペース内のファイルのみアクセス可能',
        ru: 'Только файлы в текущем рабочем пространстве', de: 'Nur Dateien im aktuellen Arbeitsbereich',
        el: 'Μόνο αρχεία εντός του τρέχοντος χώρου εργασίας', es: 'Solo archivos del espacio de trabajo actual',
        fr: 'Uniquement les fichiers de l’espace de travail actuel', pt: 'Apenas arquivos do espaço de trabalho atual',
        ro: 'Doar fișierele din spațiul de lucru curent', vi: 'Chỉ truy cập tệp trong không gian làm việc hiện tại'
    },
    'home.run.permFull': {
        'zh-Hans': '允许完全访问', 'zh-Hant': '允許完全存取', en: 'Full access',
        ja: 'フルアクセスを許可', ru: 'Полный доступ', de: 'Vollzugriff erlauben',
        el: 'Πλήρης πρόσβαση', es: 'Permitir acceso total', fr: 'Autoriser l’accès complet',
        pt: 'Permitir acesso total', ro: 'Permite acces complet', vi: 'Cho phép truy cập đầy đủ'
    },
    'home.run.permFullDesc': {
        'zh-Hans': '可读写本机文件并执行命令', 'zh-Hant': '可讀寫本機檔案並執行命令',
        en: 'Read/write local files and run commands', ja: 'ローカルファイルの読み書きとコマンド実行が可能',
        ru: 'Чтение/запись локальных файлов и выполнение команд', de: 'Lokale Dateien lesen/schreiben und Befehle ausführen',
        el: 'Ανάγνωση/εγγραφή τοπικών αρχείων και εκτέλεση εντολών', es: 'Leer/escribir archivos locales y ejecutar comandos',
        fr: 'Lire/écrire les fichiers locaux et exécuter des commandes', pt: 'Ler/gravar arquivos locais e executar comandos',
        ro: 'Citire/scriere fișiere locale și executare comenzi', vi: 'Đọc/ghi tệp máy và chạy lệnh'
    },
    'home.msg.tooLarge': {
        'zh-Hans': '消息与附件合计过大，请减少附件或精简正文', 'zh-Hant': '訊息與附件合計過大，請減少附件或精簡正文',
        en: 'Message plus attachments is too large; remove attachments or shorten the text',
        ja: 'メッセージと添付の合計が大きすぎます。添付を減らすか本文を短くしてください',
        ru: 'Сообщение с вложениями слишком большое: уберите вложения или сократите текст',
        de: 'Nachricht samt Anhängen zu groß: Anhänge entfernen oder Text kürzen',
        el: 'Το μήνυμα με τα συνημμένα είναι πολύ μεγάλο· αφαιρέστε συνημμένα ή συντομεύστε το κείμενο',
        es: 'El mensaje con adjuntos es demasiado grande: quita adjuntos o acorta el texto',
        fr: 'Message et pièces jointes trop volumineux : retirez des pièces ou raccourcissez le texte',
        pt: 'Mensagem com anexos grande demais: remova anexos ou encurte o texto',
        ro: 'Mesajul cu atașamente este prea mare: elimină atașamente sau scurtează textul',
        vi: 'Tin nhắn kèm tệp quá lớn: bớt tệp đính kèm hoặc rút gọn nội dung'
    },
    'home.msg.permDenied': {
        'zh-Hans': '未获得相机/相册权限，请在系统设置中允许后重试', 'zh-Hant': '未取得相機/相簿權限，請在系統設定中允許後重試',
        en: 'Camera/Photos permission not granted; allow it in system settings and retry',
        ja: 'カメラ/写真の権限がありません。システム設定で許可して再試行してください',
        ru: 'Нет доступа к камере/фото. Разрешите в системных настройках и повторите',
        de: 'Keine Kamera-/Fotoberechtigung: in den Systemeinstellungen erlauben und erneut versuchen',
        el: 'Δεν υπάρχει άδεια κάμερας/φωτογραφιών· επιτρέψτε τη στις ρυθμίσεις συστήματος και δοκιμάστε ξανά',
        es: 'Sin permiso de cámara/fotos: actívalo en los ajustes del sistema y reintenta',
        fr: 'Autorisation caméra/photos refusée : activez-la dans les réglages système puis réessayez',
        pt: 'Sem permissão de câmera/fotos: permita nas configurações do sistema e tente novamente',
        ro: 'Fără permisiune pentru cameră/fotografii: permite-o în setările sistemului și reîncearcă',
        vi: 'Chưa có quyền máy ảnh/ảnh: hãy cấp quyền trong cài đặt hệ thống rồi thử lại'
    },
    'home.plus.heicUnsupported': {
        'zh-Hans': '该设备无法转换 HEIC 图片，请改用 JPG/PNG 后重试', 'zh-Hant': '此裝置無法轉換 HEIC 圖片，請改用 JPG/PNG 後重試',
        en: 'This device cannot convert HEIC images; use JPG/PNG instead',
        ja: 'この端末は HEIC 画像を変換できません。JPG/PNG をご利用ください',
        ru: 'Устройство не может конвертировать HEIC; используйте JPG/PNG',
        de: 'Dieses Gerät kann HEIC nicht konvertieren; bitte JPG/PNG verwenden',
        el: 'Η συσκευή δεν μπορεί να μετατρέψει HEIC· χρησιμοποιήστε JPG/PNG',
        es: 'Este dispositivo no puede convertir HEIC; usa JPG/PNG',
        fr: 'Cet appareil ne peut pas convertir le HEIC ; utilisez JPG/PNG',
        pt: 'Este dispositivo não converte HEIC; use JPG/PNG',
        ro: 'Dispozitivul nu poate converti HEIC; folosește JPG/PNG',
        vi: 'Thiết bị không chuyển đổi được ảnh HEIC; hãy dùng JPG/PNG'
    },
    'home.plus.unsupported': {
        'zh-Hans': '当前平台暂不支持文件选择', 'zh-Hant': '目前平台暫不支援檔案選擇',
        en: 'File picker is not supported on this platform yet',
        ja: 'このプラットフォームではファイル選択に未対応です',
        ru: 'Выбор файлов на этой платформе пока не поддерживается',
        de: 'Dateiauswahl wird auf dieser Plattform noch nicht unterstützt',
        el: 'Η επιλογή αρχείων δεν υποστηρίζεται ακόμη σε αυτή την πλατφόρμα',
        es: 'Este plataforma aún no admite la selección de archivos',
        fr: 'La sélection de fichiers n’est pas encore prise en charge sur cette plateforme',
        pt: 'A seleção de arquivos ainda não é suportada nesta plataforma',
        ro: 'Selectarea fișierelor nu este încă acceptată pe această platformă',
        vi: 'Nền tảng này chưa hỗ trợ chọn tệp'
    }
};
const REMOVE = ['home.run.permissionHint'];

const dir = path.join(__dirname, '..', 'locale');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
if (files.length !== 12) throw new Error('expected 12 locale packs, got ' + files.length);
for (const f of files) {
    const lang = f.replace(/\.json$/, '');
    const p = path.join(dir, f);
    const pack = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const k of REMOVE) delete pack[k];
    for (const [k, byLang] of Object.entries(ADD)) {
        const v = byLang[lang];
        if (!v) throw new Error('missing translation ' + k + ' for ' + lang);
        pack[k] = v;
    }
    fs.writeFileSync(p, JSON.stringify(pack, null, '\t') + '\n', 'utf8');
}
// 键集对称自检
const base = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'zh-Hans.json'), 'utf8'))).sort();
for (const f of files) {
    const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).sort();
    if (JSON.stringify(keys) !== JSON.stringify(base)) throw new Error('key set mismatch: ' + f);
}
console.log('OK: +' + Object.keys(ADD).length + ' keys, -' + REMOVE.length + ' dead key, 12 packs symmetric (' + base.length + ' keys)');