const dayjs = require("dayjs");
const { serializeError } = require("serialize-error");
const ms = require("ms");
const _ = require("lodash");
const {ObjectId} = require("mongodb");
const relativeTime = require('dayjs/plugin/relativeTime')
const duration = require('dayjs/plugin/duration')

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
      console.log(`uncaughtException received\n${JSON.stringify({ error, origin })}`);
      exitCallback();
    })
    .on('unhandledRejection', (reason) => {
      console.log(`unhandledRejection received\n${JSON.stringify({ reason })}`);
      exitCallback();
    });
};

// TODO: load from config if flexibility is required
const JOB_EXPIRATION_DURATION = dayjs.duration(1, 'hour');
const JOB_EXPIRATION_DURATION_STR = JOB_EXPIRATION_DURATION.humanize();

const CLEANUP_INTERVAL_MS = _.toNumber(ms('2 min'));
const CLEANUP_INTERVAL_STR = dayjs.duration(CLEANUP_INTERVAL_MS, 'ms').humanize(true);

const cleanupStaleJobs = (agenda) => {
  const cleanup = () => {
    void (async () => {
      console.log('Stale job cleanup started ...');
      let cleanupCount = 0;

      try {
        const collection = agenda._collection || agenda._collection.collection;
        if (!collection) {
          console.log(`Cannot perform cleanup: agenda.collection not found!`);
          return;
        }

        const now = dayjs();
        const expirationTime = now.subtract(JOB_EXPIRATION_DURATION);

        await collection.find().forEach((job) => {
          const jobId = job._id;
          const lastFinishedAt = dayjs(job.lastFinishedAt);
          if (!lastFinishedAt.isValid()) {
            console.log(`Job [${job._id}] has an invalid lastFinishedAt`);
            return;
          }

          if (lastFinishedAt.isBefore(expirationTime)) {
            console.log(`[${jobId}] Deleting ${job.name} (job finished ${JOB_EXPIRATION_DURATION_STR} ago)`);
            agenda.cancel({
              _id: ObjectId(jobId),
            });
            cleanupCount++;
          }
        })
      } catch (e) {
        const error = serializeError(e);
        console.log(`cleanupStaleJobs failed with error`, error)
      }

      console.log(`Clean-up performed for ${cleanupCount} job(s)! Next cleanup runs ${CLEANUP_INTERVAL_STR}.`);
    })();

    setTimeout(cleanup, CLEANUP_INTERVAL_MS);
  };

  agenda.on("ready", async () => {
    cleanup();
  });
}

module.exports = {
  attachExitHandlers,
  cleanupStaleJobs
}
