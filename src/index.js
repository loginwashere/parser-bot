require('dotenv').config();

const schedule = require('node-schedule');
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const feed = require('feed-read');
const cheerio = require('cheerio')
const crypto = require('crypto');
const debug = require('debug')('app');

const superagent = require('superagent');
require('superagent-charset')(superagent);

const feedUrl = 'http://www.zhilstroj-2.ua/rss/';
const gaskUrl = 'http://91.205.16.115/declarate/list.php?sort=num&order=DESC';

const chatId = process.env.TELEGRAM_CHAT_ID;
const rssItemsCollectionName = process.env.RSS_ITEMS_COLLECTION_NAME || 'rss_items';
const documentsCollectionName = process.env.DOCUMENTS_COLLECTION_NAME || 'documents';

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
  object: Date,
  category: String,
  client: String,
  tech_supervisor: String,
  designer: String,
  author_supervisor: String,
  contractor: String,
  land: String,
}, { collection: documentsCollectionName });

documentSchema.virtual('title').get(() => `${this.id} ${this.object} ${this.object}`);

const DocumentItem = mongoose.model('DocumentItem', documentSchema);

const start = async () => {
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
        debug(hash.digest('hex'));

        return Object.assign({}, article, {
          id: hash.digest('hex'),
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

  const items = [];

  const region = 99;
  const year = new Date().getFullYear();
  const month = new Date().getMonth() + 1;
  const search = 'Житлобуд-2';

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

  $('table.listTable tr:not("#tableHead, .header, .pages")')
    .map((index, element) => {
      const item = {};
      $(element)
        .children('td')
        .map((i, childElement) => {
          $(childElement).text();
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


db.on('error', console.error.bind(console, 'connection error:'));
db.once('open', () => {
  const j = schedule.scheduleJob('* * * * *', () => {
    start();
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

function jobAlreadyStored(rssItem) {
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

function storeRssItem(rssItem) {
  const newRssItem = new RssItem(rssItem);
  return newRssItem.save();
}

function storeDocumentItem(documentItem) {
  const newDocumentItem = new DocumentItem(documentItem);
  return newDocumentItem.save();
}

function notify(job) {
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
