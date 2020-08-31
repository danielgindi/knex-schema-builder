const Path = require('path');
const {expect} = require('chai');
const knex = require('knex');
const mod = require('mock-knex');

const db = knex({
    client: 'sqlite',
    useNullAsDefault: true,
});

const schemaInstaller = require('../index.js');

describe('Testing install process', () => {

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

    const tracker = mod.getTracker();

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

        it('should generate user table', done => {

            tracker.once('query', query =>
                expect(query.sql.startsWith('create table `user`')).to.be.true);

            tracker.on('query', (query, step) => { // Wait for schema globals updates.
                query.response([]);
                if (step === 6)
                    done();
            });

            const schemaPath = Path.join(__dirname, './assets/db_schema');
            schemaInstaller.install(db, schemaPath);
        });
    });
});
