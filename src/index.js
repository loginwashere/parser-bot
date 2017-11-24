require('dotenv').config();

const schedule = require('node-schedule');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const feed = require('feed-read');
const cheerio = require('cheerio');
const crypto = require('crypto');
const debug = require('debug')('app');

const superagent = require('superagent');
require('superagent-charset')(superagent);

const chatId = process.env.TELEGRAM_CHAT_ID;
const rssItemsCollectionName = process.env.RSS_ITEMS_COLLECTION_NAME || 'rss_items';
const documentsCollectionName = process.env.DOCUMENTS_COLLECTION_NAME || 'documents';
const townNewsCollectionName = process.env.TOWN_NEWS_COLLECTION_NAME || 'town_news';

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

const db = mongoose.connection;

mongoose.Promise = global.Promise;
mongoose.connect(process.env.MONGODB_URI);

const rssItemSchema = mongoose.Schema({
  id: String,
  title: String,
  content: String,
  published: Date,
  author: String,
  link: String,
  feed: {
    source: String,
    link: String,
    name: String,
  }
}, { collection: rssItemsCollectionName });

const RssItem = mongoose.model('RssItem', rssItemSchema);

const documentSchema = mongoose.Schema({
  id: String,
  region: String,
  document: String,
  object: String,
  category: String,
  client: String,
  tech_supervisor: String,
  designer: String,
  author_supervisor: String,
  contractor: String,
  land: String,
}, { collection: documentsCollectionName });

documentSchema.virtual('title').get(function () { return `${this.id} ${this.object} ${this.object}`;});

const DocumentItem = mongoose.model('DocumentItem', documentSchema);

const townNewsSchema = mongoose.Schema({
  id: String,
  title: String,
  number: String,
  date: String,
  session: String,
  organizer: String,
  kind: String,
  original: String,
  status: String,
}, { collection: townNewsCollectionName });

const TownNewsItem = mongoose.model('TownNewsItem', townNewsSchema);

const processFeed = async () => {
  const feedUrl = 'http://www.zhilstroj-2.ua/rss/';

  const res = await superagent
    .get(feedUrl)
    .charset('win1251');

  feed.rss(res.text, (err, articles) => {
    if (err) throw err;
    const preparedArticles = articles
      .map((article) => {
        const hash = crypto.createHash('sha256');
        hash.update(article.link);

        debug(article);
        const hashString = hash.digest('hex');
        debug(hashString);

        return Object.assign({}, article, {
          id: hashString,
        });
      });

    debug(preparedArticles, 'response');

    all(preparedArticles.map(rssItemAlreadyStored))
      .then(accumulator => {
        debug(accumulator);
        return all(accumulator
          .filter(item => item.status === 'resolved')
          .map(item => item.value)
          .filter(Boolean)
          .map(storeRssItem))
      })
      .then(accumulator => {
        debug(accumulator);
        return all(accumulator
          .filter(item => item.status === 'resolved')
          .map(item => item.value)
          .filter(Boolean)
          .map(notify))
      })
      .then(accumulator => debug(accumulator));
  });
};

const processGask = async () => {
  const gaskUrl = 'http://91.205.16.115/declarate/list.php?sort=num&order=DESC';

  const fields = [
    'id',
    'region',
    'document',
    'object',
    'category',
    'client',
    'tech_supervisor',
    'designer',
    'author_supervisor',
    'contractor',
    'land',
  ];

  const region = process.env.REGION || 99;
  const currentMonthDate = new Date();
  const previousMonthDate = new Date();
  previousMonthDate.setMonth(previousMonthDate.getMonth() - 1);
  const dates = [
    previousMonthDate,
    currentMonthDate,
  ];

  for (let date of dates) {
    const year = process.env.YEAR || date.getFullYear();
    const month = process.env.MONTH || date.getMonth() + 1;
    const search = process.env.SEARCH || 'Житлобуд-2';

    debug(region, year, month, search);

    const gaskRes = await superagent
      .post(gaskUrl)
      .type('form')
      .send({
        'filter[regob]': region,
        'filter[date]': year,
        'filter[date2]': month,
        'filter[confind]': search
      });

    const $ = cheerio.load(gaskRes.text)

    const items = [];
    $('table.listTable tr:not("#tableHead, .header, .pages")')
      .map((index, element) => {
        const item = {};
        $(element)
          .children('td')
          .map((i, childElement) => {
            item[fields[i]] = $(childElement).text().trim();
          });
        items.push(item)
      });

    debug(items);

    all(items.map(documentItemAlreadyStored))
      .then(accumulator => {
        debug(accumulator);
        return all(accumulator
          .filter(item => item.status === 'resolved')
          .map(item => item.value)
          .filter(Boolean)
          .map(storeDocumentItem))
      })
      .then(accumulator => {
        debug(accumulator);
        return all(accumulator
          .filter(item => item.status === 'resolved')
          .map(item => item.value)
          .filter(Boolean)
          .map(notify))
      })
      .then(accumulator => debug(accumulator));
  }
};

const processTownNews = async () => {
  const loginUrl = 'https://doc.citynet.kharkov.ua/ru/user/login';
  const searchUrl = 'https://doc.citynet.kharkov.ua/ru/profile/search/index?doc_id_label=&doc_id=&doc_id_div=0&doc_id_end=&qstring=%D0%96%D0%B8%D1%82%D0%BB%D0%BE%D0%B1%D1%83%D0%B4-2&in_text=0&all_words=0&doc_number_label=&doc_number_pref=&doc_number_lb1=&doc_number_suff=&doc_number_div=0&doc_number_pref_end=&doc_number_lb2=&doc_number_suff_end=&doc_convocation_label=&doc_convocation=&doc_convocation_div=0&doc_convocation_end=&doc_session_label=&doc_session=&doc_session_div=0&doc_session_end=&doc_date_label=&doc_date_from=&doc_date_div=0&doc_date_end=&doc_dateadd_label=&doc_dateadd_from=&doc_dateadd_div=0&doc_dateadd_end=&newSearch=1&total=&cat=&organ=&status=&original=0&search=%D0%98%D1%81%D0%BA%D0%B0%D1%82%D1%8C';

  const password = process.env.TOWN_NEWS_PASSWORD;

  const hash = crypto.createHash('md5');
  hash.update(password);

  const hashString = hash.digest('hex');
  debug(hashString);

  const agent = superagent.agent();

  await agent
    .get(loginUrl);

  await agent
    .post(loginUrl)
    .type('form')
    .send({ login: process.env.TOWN_NEWS_LOGIN })
    .send({ password })
    .send({ hash_password: hashString });

  const searchResponse = await agent
    .get(searchUrl);

  const $ = cheerio.load(searchResponse.text);

  const fields = [
    'title',
    'number',
    'date',
    'session',
    'organizer',
    'kind',
    'original',
    'status',
  ];

  const items = [];
  $('dt.check > input')
    .map((index, element) => {
      const item = {};
      item.id = $(element).val().trim();
      $(element)
        .parent('dt')
        .parent('dl')
        .find('dd.s_r_item_wrapp dl')
        .children()
        .map((i, childElement) => {
          item[fields[i]] = $(childElement).text().trim();
        });
      items.push(item)
    });

  debug(items);

  all(items.map(townNewsItemAlreadyStored))
    .then(accumulator => {
      debug(accumulator);
      return all(accumulator
        .filter(item => item.status === 'resolved')
        .map(item => item.value)
        .filter(Boolean)
        .map(storeTownNewsItem))  
    })
    .then(accumulator => {
      debug(accumulator);
      return all(accumulator
        .filter(item => item.status === 'resolved')
        .map(item => item.value)
        .filter(Boolean)
        .map(notify))
    })
    .then(accumulator => debug(accumulator));
};

const run = async () => {
  try {
    await processFeed();
  } catch (e) {
    debug('ERROR', e);
  }

  try {
    await processGask();
  } catch (e) {
    debug('ERROR', e);
  }

  try {
    await processTownNews();
  } catch (e) {
    debug('ERROR', e);
  }
}

db.on('error', console.error.bind(console, 'connection error:'));
db.once('open', () => {
  const j = schedule.scheduleJob('* * * * *', () => {
    run();
  });
});

function all(promises) {
  const accumulator = [];
  let ready = Promise.resolve(null);

  promises.forEach((promise, ndx) => {
    ready = ready.then(() => {
      return promise;
    }).then((value) => {
      accumulator[ndx] = { status: 'resolved', value: value };
    })
    .catch(err => accumulator[ndx] = { status: 'rejected', value: err });
  });

  return ready.then(() => accumulator);
}

function rssItemAlreadyStored(rssItem) {
  return RssItem.findOne({ id: rssItem.id })
    .then(foundRssItem => foundRssItem
      ? Promise.reject(foundRssItem)
      : Promise.resolve(rssItem))
}

function documentItemAlreadyStored(documentItem) {
  return DocumentItem.findOne({ id: documentItem.id })
    .then(foundDocumentItem => foundDocumentItem
      ? Promise.reject(foundDocumentItem)
      : Promise.resolve(documentItem))
}

function townNewsItemAlreadyStored(townNewsItem) {
  return TownNewsItem.findOne({ id: townNewsItem.id })
    .then(foundTownNewsItem => foundTownNewsItem
      ? Promise.reject(foundTownNewsItem)
      : Promise.resolve(townNewsItem))
}

function storeRssItem(rssItem) {
  const newRssItem = new RssItem(rssItem);
  return newRssItem.save();
}

function storeDocumentItem(documentItem) {
  const newDocumentItem = new DocumentItem(documentItem);
  return newDocumentItem.save();
}

function storeTownNewsItem(townNewsItem) {
  const newTownNewsItem = new TownNewsItem(townNewsItem);
  return newTownNewsItem.save();
}

function notify(item) {
  return bot.sendMessage(chatId, formatMessage(item), {
    parse_mode: 'HTML'
  });
}

function formatMessage(item) {
  return [
    formatTitle(item),
  ]
  .filter(Boolean)
  .join('\n');
}

function formatTitle(item) {
  return `<b>${item.title}</b>`;
}
