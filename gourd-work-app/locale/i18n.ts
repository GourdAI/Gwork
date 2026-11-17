import { createI18n } from 'vue-i18n'
import en from './en.json'
import zhHans from './zh-Hans.json'
import zhHant from './zh-Hant.json'
import ja from './ja.json'
import ru from './ru.json'
import de from './de.json'
import el from './el.json'
import es from './es.json'
import fr from './fr.json'
import pt from './pt.json'
import ro from './ro.json'
import vi from './vi.json'

export const i18n = createI18n({
	legacy: false,
	locale: 'zh-Hans',
	fallbackLocale: 'en',
	messages: {
		en,
		'zh-Hans': zhHans,
		'zh-Hant': zhHant,
		ja,
		ru,
		de,
		el,
		es,
		fr,
		pt,
		ro,
		vi
	}
})