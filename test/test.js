const Path = require('path');
const {expect} = require('chai');
const knex = require('knex');
const mod = require('mock-knex');

const db = knex({
    client: 'sqlite',
    useNullAsDefault: true,
});

const schemaInstaller = require('../index.js');

describe('Testing knex-schema-builder:', () => {

    const tracker = mod.getTracker();

    before(done => {
        mod.mock(db);
        done();
    });

    after(done => {
        mod.unmock(db);
        done();
    })

    beforeEach(done => {
        tracker.install();
        done();
    });

    afterEach(done => {
        tracker.uninstall();
        done();
    });

    describe('Testing helpers:', () => {
        describe('When install is needed', () => {

            it('should return true', () => {

                tracker.on('query', (query, step) =>
                    [
                        () => query.response([]),
                        () => query.response([]),
                        () => {
                            expect(query.sql).to.equal('select `value` from `schema_globals` where `key` = ? limit ?');
                            query.response(undefined);
                        }
                    ][step - 1]());

                const schemaPath = Path.join(__dirname, './assets/db_schema_install');

                return schemaInstaller.isInstallNeeded(db, schemaPath)
                    .then(isNeeded => expect(isNeeded).to.be.true);

            })
        });

        describe('When install is not needed', () => {

            it('should return false', () => {

                tracker.on('query', (query, step) =>
                    [
                        () => query.response([{TABLE_NAME: 'schema_globals'}]),
                        () => query.response({value: 1}),
                    ][step - 1]());

                const schemaPath = Path.join(__dirname, './assets/db_schema_install');

                return schemaInstaller.isInstallNeeded(db, schemaPath)
                    .then(isNeeded => expect(isNeeded).to.be.false);

            })
        });

        describe('When upgrade is needed', () => {

            it('should return true', () => {

                tracker.on('query', (query, step) =>
                    [
                        () => query.response([{TABLE_NAME: 'schema_globals'}]),
                        () => query.response({value: 1}),
                    ][step - 1]());

                const schemaPath = Path.join(__dirname, './assets/db_schema_upgrade');

                return schemaInstaller.isUpgradeNeeded(db, schemaPath)
                    .then(isNeeded => expect(isNeeded).to.be.true);

            })
        });

        describe('When upgrade is not needed', () => {

            it('should return false', () => {

                tracker.on('query', (query, step) =>
                    [
                        () => query.response([{TABLE_NAME: 'schema_globals'}]),
                        () => query.response({value: 3}),
                    ][step - 1]());

                const schemaPath = Path.join(__dirname, './assets/db_schema_upgrade');

                return schemaInstaller.isUpgradeNeeded(db, schemaPath)
                    .then(isNeeded => expect(isNeeded).to.be.false);

            })
        });
    });

    describe('Testing install:', () => {

        describe('In case there is bad version.json file', () => {
            const schemaPath = Path.join(__dirname, './assets/db_schema_wrong_version');

            it('should throw error', done => {
                schemaInstaller.install(db, schemaPath, err => {
                    expect(err.message).to.equal('Unexpected end of JSON input');
                    done();
                });
            })
        });

        describe('In case there is empty schema.json', () => {

            it('should generate schema_globals table', done => {

                tracker.on('query', query => {
                    query.response([]);

                    if (query.sql.startsWith('insert into `schema_globals`')) {
                        expect(query.bindings[0]).to.equal('db_version');
                        expect(query.bindings[1]).to.equal(1);
                        done();
                    }
                });

                const schemaPath = Path.join(__dirname, './assets/db_schema_empty');
                schemaInstaller.install(db, schemaPath);
            });
        });

        describe('In case there is schema.json with user table', () => {

            it('should create user table', done => {

                tracker.once('query', query =>
                    expect(query.sql.startsWith('create table `user`')).to.be.true);

                tracker.on('query', (query, step) => { // Wait for schema globals updates.
                    query.response([]);
                    if (step === 6)
                        done();
                });

                const schemaPath = Path.join(__dirname, './assets/db_schema_install');
                schemaInstaller.install(db, schemaPath);
            });
        });
    })


    describe('Testing upgrade:', () => {

        describe('In case there is bad version.json file', () => {

            it('should throw error', done => {

                tracker.on('query', (query, step) =>
                    [
                        () => query.response([{TABLE_NAME: 'schema_globals'}]),
                        () => query.response({value: 1}),
                    ][step - 1]());

                const schemaPath = Path.join(__dirname, './assets/db_schema_wrong_version');

                schemaInstaller.upgrade(db, schemaPath, err => {
                    expect(err.message).to.equal('Unexpected end of JSON input');
                    done();
                });
            })
        });

        describe('In case there is a team table to add', () => {

            it('should create team table,\n\t add team_id column to user table, \n\t and update schema_globals', done => {

                tracker.on('query', (query, step) =>
                    [
                        () => query.response([{TABLE_NAME: 'schema_globals'}]),
                        () => query.response({value: 2}),
                        () => {
                            expect(query.sql).to.equal('create table `team` (`id` integer not null primary key autoincrement, `name` varchar(32))');
                            query.response([]);
                        },
                        () => {
                            expect(query.sql).to.equal('alter table `user` add column `team_id` bigint');
                            query.response([]);
                        },
                        () => query.response([{TABLE_NAME: 'schema_globals'}]),
                        () => query.response({value: 2}),
                        () => {
                            expect(query.sql).to.equal('update `schema_globals` set `value` = ? where `key` = ?');
                            expect(query.bindings[0]).to.equal(3);
                            query.response([]);
                        },
                    ][step - 1]());

                const schemaPath = Path.join(__dirname, './assets/db_schema_upgrade');

                schemaInstaller.upgrade(db, schemaPath, err => {
                    expect(err).to.be.null;
                    done();
                });
            })
        })
    });
});