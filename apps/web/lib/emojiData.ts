/**
 * Набор эмодзи для пикера в чате. Курируемый список вместо полной базы
 * Unicode (тысячи символов, сотни КБ данных) — самые ходовые в рабочей
 * переписке, сгруппированные как в Telegram. Ключевые слова — для поиска
 * (на русском и английском).
 */
export interface EmojiCategory {
  key: string;
  label: string;
  icon: string;
  emojis: { e: string; k: string }[];
}

const raw: [string, string, string, string][] = [
  // [category key, label, icon, "emoji:keywords|emoji:keywords|..."]
  [
    'smileys',
    'Смайлы',
    '😀',
    '😀:улыбка smile grin|😃:радость happy|😄:смех laugh|😁:ухмылка grin|😆:хохот lol|😅:пот облегчение sweat|🤣:ржу rofl|😂:слёзы смеха joy lol|🙂:улыбка slight|😉:подмигнуть wink|😊:румянец blush|😇:ангел angel|🥰:любовь love|😍:влюблён heart eyes|🤩:восторг star|😘:поцелуй kiss|😋:вкусно yum|😛:язык tongue|😜:шалость wink tongue|🤪:безумие crazy|🤗:обнимаю hug|🤭:ой oops|🤫:тсс shh|🤔:думаю think|🫡:есть salute|🤐:молчу zip|🤨:хм бровь|😐:нейтрально neutral|😑:без эмоций|😶:молчание|😏:ухмылка smirk|😒:недоволен unamused|🙄:закатил глаза eyeroll|😬:неловко grimace|😮‍💨:выдох|😌:облегчение relieved|😔:грусть pensive|😪:сонный sleepy|😴:сплю sleep|😷:болею mask|🤒:температура sick|🤯:взрыв мозга mind blown|🥳:праздник party|😎:круто cool|🤓:ботаник nerd|🧐:монокль|😕:растерян confused|😟:беспокойство worried|🙁:грустно|😮:удивление wow|😯:ого|😲:шок astonished|😳:смущение flushed|🥺:прошу pleading|😢:плачу cry|😭:рыдаю sob|😱:ужас scream|😖:мучение|😣:упорство|😞:разочарован disappointed|😓:устал|😩:утомлён weary|😫:устал tired|🥱:зеваю yawn|😤:злюсь triumph|😡:гнев angry|😠:злой mad|🤬:ругаюсь|😈:черт devil|💀:череп skull|💩:какашка poop|🤡:клоун clown|👻:призрак ghost|👽:инопланетянин alien|🤖:робот robot',
  ],
  [
    'gestures',
    'Жесты',
    '👍',
    '👍:да лайк ok like thumbs up|👎:нет дизлайк dislike|👌:окей ok|🤌:итальянский|✌️:мир victory|🤞:удачи fingers crossed|🤟:люблю|🤘:рок rock|🤙:позвони call|👈:влево left|👉:вправо right|👆:вверх up|👇:вниз down|☝️:внимание|✋:стоп hand|🤚:рука|🖐️:пять|🖖:вулкан|👋:привет пока wave hi bye|🤝:договорились handshake deal|🙏:спасибо пожалуйста thanks please|👏:аплодисменты clap|🙌:ура hooray|👐:открытые руки|🤲:ладони|💪:сила strong|🫶:сердце руки|✍️:пишу write|🤳:селфи|💅:маникюр|👀:смотрю eyes look|🧠:мозг brain|🫠:таю melt',
  ],
  [
    'hearts',
    'Сердца',
    '❤️',
    '❤️:сердце любовь love heart|🧡:оранжевое|💛:жёлтое|💚:зелёное|💙:синее|💜:фиолетовое|🖤:чёрное|🤍:белое|🤎:коричневое|💔:разбитое broken|❤️‍🔥:огонь любви|💕:два сердца|💞:сердца|💓:бьётся|💗:растёт|💖:блеск|💘:стрела|💝:подарок|💯:сто 100|✨:блеск sparkles|⭐:звезда star|🌟:сияние|💫:головокружение|🔥:огонь fire hot|💥:бум boom|🎉:праздник party tada|🎊:конфетти|🎈:шарик balloon|🎁:подарок gift|🏆:кубок trophy|🥇:первое место|🏅:медаль medal',
  ],
  [
    'work',
    'Работа',
    '💼',
    '💼:портфель работа work|📌:закрепить pin|📎:скрепка clip|✅:готово done check|☑️:отмечено|✔️:галочка|❌:нет cross|❗:важно|❓:вопрос question|⚠️:внимание warning|🚀:запуск rocket launch|🎯:цель target|📈:рост график growth|📉:падение|📊:диаграмма chart|🗂️:папки|📁:папка folder|📄:документ doc|📝:заметка note|📅:календарь calendar|🗓️:дата|⏰:будильник alarm|⏳:ожидание|⌛:время|🕐:час|💡:идея idea|🔍:поиск search|🔒:закрыто lock|🔑:ключ key|⚙️:настройки settings|🛠️:инструменты tools|🐛:баг bug|💻:ноутбук laptop|🖥️:компьютер|📱:телефон phone|☎️:звонок|📞:трубка call|✉️:письмо mail|📧:почта email|📢:объявление|🔔:уведомление bell|💬:сообщение chat|🗨️:реплика|☕:кофе coffee|🍕:пицца pizza|🍰:торт cake|🍻:пиво beer|🥂:тост cheers',
  ],
  [
    'nature',
    'Природа',
    '🌿',
    '☀️:солнце sun|🌤️:облачно|⛅:облака|🌧️:дождь rain|⛈️:гроза|❄️:снег snow|🌈:радуга rainbow|🌙:луна moon|⚡:молния|🌊:волна wave|🌸:цветок flower|🌹:роза rose|🌻:подсолнух|🌷:тюльпан|🌱:росток|🌿:ветка|🍀:клевер удача|🍁:лист|🌲:ёлка|🌴:пальма|🐶:собака dog|🐱:кот cat|🦊:лиса fox|🐻:медведь bear|🐼:панда panda|🐨:коала|🐯:тигр|🦁:лев lion|🐸:лягушка frog|🐵:обезьяна|🙈:не вижу|🙉:не слышу|🙊:молчу|🐧:пингвин|🦄:единорог unicorn|🐝:пчела|🦋:бабочка|🐢:черепаха|🐙:осьминог',
  ],
  [
    'travel',
    'Разное',
    '🚗',
    '🚗:машина car|🚕:такси|🚌:автобус|🚆:поезд train|✈️:самолёт plane|🚢:корабль|🏠:дом home|🏢:офис office|🏖️:отпуск пляж vacation|⛰️:горы|🗺️:карта map|🎮:игра game|⚽:футбол|🏀:баскетбол|🎵:музыка music|🎧:наушники|🎬:кино|📷:фото camera|🎂:день рождения birthday|🍾:шампанское|🎄:новый год ёлка|🎃:хэллоуин|🧩:пазл|♻️:переработка|🆗:ок|🆕:новое new|🔝:топ|🔴:красный|🟢:зелёный|🟡:жёлтый|🔵:синий|⚪:белый|⚫:чёрный',
  ],
];

export const EMOJI_CATEGORIES: EmojiCategory[] = raw.map(([key, label, icon, list]) => ({
  key,
  label,
  icon,
  emojis: list.split('|').map((pair) => {
    const idx = pair.indexOf(':');
    return { e: pair.slice(0, idx), k: pair.slice(idx + 1).toLowerCase() };
  }),
}));

export const ALL_EMOJIS = EMOJI_CATEGORIES.flatMap((c) => c.emojis);
