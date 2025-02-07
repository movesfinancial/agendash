#!/usr/bin/env node
"use strict";
const { Agenda } = require("agenda");
const agendash = require("../app");
const Fastify = require("fastify");
const program = require("./agendash-options");
const {cleanupStaleJobs, attachExitHandlers, notifyOnFailure } = require("./utils");

attachExitHandlers();

const fastify = Fastify();

const agenda = new Agenda().database(program.db, program.collection);

fastify.register(
  agendash(agenda, {
    middleware: "fastify",
    title: program.title,
  })
);

fastify.listen({ port: program.port }, function () {
  console.log(
    `Agendash started http://localhost:${program.port}${program.path}`
  );
});

cleanupStaleJobs(agenda);
notifyOnFailure(agenda, program.notify, program.env);
