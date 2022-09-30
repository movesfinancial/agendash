const dayjs = require("dayjs");
const { serializeError } = require("serialize-error");
const ms = require("ms");
const _ = require("lodash");
const {ObjectId} = require("mongodb");
const relativeTime = require('dayjs/plugin/relativeTime')
const duration = require('dayjs/plugin/duration')
const sgMail = require('@sendgrid/mail');

dayjs.extend(duration)
dayjs.extend(relativeTime)

const attachExitHandlers = (exitCallback = (code = 1) => { process.exit(code)}) => {
  // https://blog.heroku.com/best-practices-nodejs-errors
  // https://stackoverflow.com/a/14032965/1327178
  [`SIGINT`, `SIGTERM`, `SIGUSR1`, `SIGUSR2`].forEach((event) => {
    process.on(event, () => {
      console.log(`\n${event} received`);
      exitCallback(0);
    });
  });
  process
    /* NodeJS process will exit when:
     * - the event loop's queue is empty.
     * - no background/asynchronous tasks remain that are capable of adding to the queue. */
    .on('exit', () => {
      console.log('NodeJS has nothing more to execute ...');
      exitCallback();
    })
    .on('uncaughtException', (error, origin) => {
      console.log(`uncaughtException received`, { error: serializeError(error), origin });
      exitCallback();
    })
    .on('unhandledRejection', (reason) => {
      console.log(`unhandledRejection received`, { reason });
      exitCallback();
    });
};

// TODO: load from config if flexibility is required
const JOB_EXPIRATION_DURATION = dayjs.duration(1, 'hour');
const JOB_EXPIRATION_DURATION_STR = JOB_EXPIRATION_DURATION.humanize();

const CLEANUP_INTERVAL_MS = _.toNumber(ms('1 hour'));
const CLEANUP_INTERVAL_STR = dayjs.duration(CLEANUP_INTERVAL_MS, 'ms').humanize(true);

const cleanupStaleJobs = (agenda) => {
  const cleanup = () => {
    void (async () => {
      console.log(`Cleaning-up completed one-shot jobs older than ${JOB_EXPIRATION_DURATION_STR} ...`);

      try {
        let cleanupCount = 0;
        let totalJobCount = 0;

        const collection = agenda._collection || agenda._collection.collection;
        if (!collection) {
          console.log(`Cannot perform cleanup: agenda.collection not found!`);
          return;
        }

        const now = dayjs();
        const expirationTime = now.subtract(JOB_EXPIRATION_DURATION);

        await collection.find({ type: 'normal' }).forEach((job) => {
          totalJobCount++;
          const jobId = job._id;

          if (!job.lastFinishedAt) {
            // skip job since it hasn't finished yet
            return;
          }
          const lastFinishedAt = dayjs(job.lastFinishedAt);
          if (!lastFinishedAt.isValid()) {
            console.log(`[${job._id}] Skipping job due to invalid lastFinishedAt date`);
            return;
          }

          if (lastFinishedAt.isBefore(expirationTime)) {
            console.log(`[${jobId}] Deleting ${job.name} (job finished ${lastFinishedAt.fromNow()})`);
            agenda.cancel({
              _id: ObjectId(jobId),
            });
            cleanupCount++;
          }
        })

        console.log(`Cleaned-up ${cleanupCount}/${totalJobCount} one-shot job(s)! Next cleanup runs ${CLEANUP_INTERVAL_STR}.`);
      } catch (e) {
        console.log(`Stale job cleanup procedure failed with exception: `, { error: serializeError(e) })
      }
    })();

    setTimeout(cleanup, CLEANUP_INTERVAL_MS);
  };

  agenda.once("ready", async () => {
    cleanup();
  });
}


// TODO: load from config if flexibility is required
const NOTIFY_INTERVAL_MS = _.toNumber(ms('15m'));
const NOTIFY_INTERVAL_STR = dayjs.duration(NOTIFY_INTERVAL_MS, 'ms').humanize(true);

// agenda: Agenda instance
// notificationList: String, list of emails to send notifications to
const notifyOnFailure = (agenda, notificationList, agendashEnv) => {
  if (!notificationList || !_.isString(notificationList)) {
    console.log('Failed-job notifications disabled! Please set AGENDASH_NOTIFY_EMAILS env-var or the --notify arg to enable.')
    return;
  }

  const recipients = String(notificationList).split(',').map(v => v.trim());
  if (!recipients.length || recipients.length < 1) {
    console.log('Failed-job notifications disabled! Recipient list must be a comma-separated list of valid emails.');
    return;
  }
  // we don't do any further validation on emails here ...

  const sgApiKey = process.env.SENDGRID_API_KEY;
  if (!sgApiKey) {
    console.log('Failed-job notifications disabled! Please set SENDGRID_API_KEY to enable.')
    return;
  }
  sgMail.setApiKey(sgApiKey);

  // load the environment label
  const env = agendashEnv || process.env.NODE_ENV;

  const notify = () => {
    void (async () => {
      try {
        // mongoose internals changed at some point ... this will fix crash for older versions.
        const mongoDb = agenda._mdb.admin ? agenda._mdb : agenda._mdb.db;

        if (!mongoDb) {
          console.log(`Cannot perform failed-job notification: agenda._mdb not found!`);
          return;
        }

        const notifyCollection = mongoDb.collection('jobFailures');
        // no need to check if collection exists, since it will be created on first write

        const jobsCollection = agenda._collection || agenda._collection.collection;
        if (!jobsCollection) {
          console.log(`Cannot perform failed-job notification: agenda.collection not found!`);
          return;
        }

        console.log(`Scanning failed jobs to notify admins ...`);

        // find all "failed" jobs.
        // definition of failed lifted from: https://github.com/agenda/agendash/blob/308e7debc4474e4302ea87d353bca70d12190f3b/lib/controllers/agendash.js#L92
        const failedJobs = await jobsCollection.find({
          $expr: { $and: [
              "$lastFinishedAt",
              "$failedAt",
              { $eq: ["$lastFinishedAt", "$failedAt"] },
            ]
          }
        });

        let numFailed = 0;
        let numNotified = 0;

        while(await failedJobs.hasNext()) {
          numFailed++;

          const job = await failedJobs.next();
          const { _id, failedAt, name } = job;

          // since we're filtering by _id, we don't expect to find either 0 or 1 entities
          const didSendNotification = await notifyCollection.findOne({ _id, failedAt });

          if (!didSendNotification) {
            // we have NOT yet sent a notification for this failure ...

            // send notification now
            const subject = `[Agenda]${env ? `[${env}]` : ''} Job Failed: ${name} @ ${failedAt.toISOString()}`
            const text = `${subject}\n\n` +
                         `Please query Datadog for crash logs. Job snapshot:\n${JSON.stringify(job, undefined, 2)}\n\n` +
                         `This message was generated by the Agendash process${ env ? ` running on ${env}` : ''}.`

            console.log(`Job [${name}] failed @ ${failedAt.toISOString()}`);

            for (let i = 0; i < recipients.length; i++) {
              try {
                const msg = {
                  to: recipients[i],
                  from: 'agendash@movesfinancial.com',
                  subject,
                  text,
                };
                await sgMail.send(msg);
              } catch (error) {
                console.error(error);

                if (error.response) {
                  console.error(error.response.body)
                }
              }
            }

            // create a 'notification record', to notify AT-MOST once per failure
            /**
             * Notice that the notification record is generated on a best-effort-basis:
             *   i.e. we don't gate notification record generation on success of email delivery;
             *   we would rather not spam the admin with spurious emails than miss a few notifications ...
             */
            await notifyCollection.replaceOne({ _id }, {
              failedAt,
              notification: {
                recipients,
                subject,
                text,
              }}, { upsert: true });

            numNotified++;
          }

          // otherwise do nothing since we've already notified user of failure on a previous iteration
        }

        console.log(`Generated notifications for ${numNotified}/${numFailed} failed job(s)! Next fail-scan runs ${NOTIFY_INTERVAL_STR}.`);
      } catch (e) {
        console.log(`Failed-job notifier crashed with exception: `, { error: serializeError(e) })
      }
    })();

    setTimeout(notify, NOTIFY_INTERVAL_MS);
  };

  agenda.once("ready", async () => {
    notify();
  });
}


module.exports = {
  attachExitHandlers,
  cleanupStaleJobs,
  notifyOnFailure,
}
