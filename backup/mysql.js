"use strict";

const PromiseHelper = require('../util/promises');

/** @const */
const NEW_LINE = '\r\n';

/** @const */
const DELIMITER = '$$';

/** @typedef {{wrapInTransaction: Boolean?, routines: Boolean?, triggers: Boolean?, dropTable: Boolean?, tableStructure: Boolean?, tableData: Boolean?}} MysqlBackupOptions */

/**
 * @enum {string}
 */
const DbObjectType = {
    Procedure: 'Procedure',
    Function: 'Function',
    Event: 'Event',
    View: 'View',
    Table: 'Table',
    Trigger: 'Trigger'
};

/**
 * Returns MYSQL representation of the object type
 * @param {DbObjectType} type
 */
const dbObjectTypeFromType = function (type) {
    switch (type) {
        case DbObjectType.Procedure:
            return 'Procedure';
        case DbObjectType.Function:
            return 'Function';
        case DbObjectType.Event:
            return 'Event';
        case DbObjectType.View:
            return 'View';
        case DbObjectType.Table:
            return 'Table';
        case DbObjectType.Trigger:
            return 'Trigger';
    }
    return null;
};

/**
 * Wraps an object name for MySql
 * @param {string} name
 * @returns {string}
 */
const wrapObjectName = function (name) {
    return '`' + name.replace(/`/g, '``') + '`';
};

class MysqlBackupController {

    /**
     * Exports the db structure and data to the specified stream
     * @param {knex} knex
     * @param {NodeJS.WritableStream} outputStream
     * @param {MysqlBackupOptions} options
     * @returns {Promise}
     */
    static generateBackup(knex, outputStream, options) {

        outputStream.write('DELIMITER ' + DELIMITER + NEW_LINE);
        outputStream.write('SET FOREIGN_KEY_CHECKS=0 ' + DELIMITER + NEW_LINE);
        outputStream.write('SET SQL_MODE="NO_AUTO_VALUE_ON_ZERO" ' + DELIMITER + NEW_LINE);
        outputStream.write('SET AUTOCOMMIT=0 ' + DELIMITER + NEW_LINE);

        if (options.wrapInTransaction) {
            outputStream.write('START TRANSACTION ' + DELIMITER + NEW_LINE);
        }

        return Promise.resolve()
                      .then(() => {
                          if (options.routines) {
                              return MysqlBackupController.exportRoutines(knex, outputStream, options);
                          }
                      })
                      .then(() => {
                          if (options.tableStructure) {
                              return MysqlBackupController.exportTableStructure(knex, outputStream, options);
                          }
                      })
                      .then(() => {
                          if (options.tableData) {
                              return MysqlBackupController.exportTableData(knex, outputStream, options);
                          }
                      })
                      .then(() => {
                          if (options.triggers) {
                              return MysqlBackupController.exportTriggers(knex, outputStream, options);
                          }
                      })
                      .then(() => {
                          outputStream.write('SET FOREIGN_KEY_CHECKS=1 ' + DELIMITER + NEW_LINE);
                      })
                      .then(() => {
                          if (options.wrapInTransaction) {
                              outputStream.write('COMMIT ' + DELIMITER + NEW_LINE);
                          }
                      });
    }

    /**
     * Exports a CREATE query for an object by type and name
     * @param {knex} knex
     * @param {DbObjectType} objectType
     * @param {String} objectName
     * @param {Boolean = false} ifNotExists
     * @returns {Promise}
     */
    static getObjectCreate(knex, objectType, objectName, ifNotExists) {

        const sql = 'SHOW CREATE ' + dbObjectTypeFromType(objectType) + ' ' + wrapObjectName(objectName);

        return /**@type Promise*/knex.raw(sql).then(resp => {

            const rows = resp[0];
            if (!rows.length) {
                throw new Error('Object not found: ' + objectName);
            }

            let resultColumn = '';

            switch (objectType) {
                case DbObjectType.Procedure:
                    resultColumn = "Create Procedure";
                    break;
                case DbObjectType.Function:
                    resultColumn = "Create Function";
                    break;
                case DbObjectType.Event:
                    resultColumn = "Create Event";
                    break;
                case DbObjectType.View:
                    resultColumn = "Create View";
                    break;
                case DbObjectType.Table:
                    resultColumn = "Create Table";
                    break;
                case DbObjectType.Trigger:
                    resultColumn = "SQL Original Statement";
                    break;
            }

            let create = rows[0][resultColumn];

            if (ifNotExists && create) {
                create = create.replace(
                    /^(CREATE\s+(DEFINER\s*=\s*(`(?:[^`]|``)+`|[a-zA-Z0-9$_]+)(@(`(?:[^`]|``)+`|[a-zA-Z0-9$_.]+))?\s+)?PROCEDURE\s+)(`(?:[^`]|``)+`|[a-zA-Z0-9$_]+)/,
                    'DROP PROCEDURE IF EXISTS $5 ' + DELIMITER.replace(/\$/g, '$$$$') + NEW_LINE + '$1$5');
                create = create.replace(
                    /^(CREATE\s+(DEFINER\s*=\s*(`(?:[^`]|``)+`|[a-zA-Z0-9$_]+)(@(`(?:[^`]|``)+`|[a-zA-Z0-9$_.]+))?\s+)?FUNCTION\s+)(`(?:[^`]|``)+`|[a-zA-Z0-9$_]+)/,
                    'DROP FUNCTION IF EXISTS $5 ' + DELIMITER.replace(/\$/g, '$$$$') + NEW_LINE + '$1$5');
                create = create.replace(
                    /^(CREATE\s+(DEFINER\s*=\s*(`(?:[^`]|``)+`|[a-zA-Z0-9$_]+)(@(`(?:[^`]|``)+`|[a-zA-Z0-9$_.]+))?\s+)?EVENT\s+)/,
                    '$1IF NOT EXISTS ');
                create = create.replace(
                    /^(CREATE\s+(DEFINER\s*=\s*(`(?:[^`]|``)+`|[a-zA-Z0-9$_]+)(@(`(?:[^`]|``)+`|[a-zA-Z0-9$_.]+))?\s+)?TRIGGER\s+)/,
                    '$1IF NOT EXISTS ');
                create = create.replace(/^(CREATE\s+VIEW)/, '$1 OR REPLACE');
                create = create.replace(/^(CREATE\s+TABLE)/, '$1 IF NOT EXISTS');
            }

            return create;
        });
    }

    /**
     * Exports an object list by objectType
     * @param {knex} knex
     * @param {DbObjectType} objectType
     * @returns {Promise}
     */
    static getObjectList(knex, objectType) {

        let query;
        switch (objectType) {
            case DbObjectType.Table:
                query = knex.select('TABLE_NAME AS name').from('INFORMATION_SCHEMA.TABLES')
                            .where('TABLE_SCHEMA', knex.raw('DATABASE()'))
                            .andWhere('TABLE_TYPE', 'BASE TABLE');
                break;
            case DbObjectType.Event:
                query = knex.select('EVENT_NAME AS name').from('INFORMATION_SCHEMA.EVENTS')
                            .where('EVENT_SCHEMA', knex.raw('DATABASE()'));
                break;
            case DbObjectType.Function:
            case DbObjectType.Procedure:
                query = knex.select('SPECIFIC_NAME AS name').from('INFORMATION_SCHEMA.ROUTINES')
                            .where('ROUTINE_SCHEMA', knex.raw('DATABASE()'))
                            .where('ROUTINE_TYPE', objectType === DbObjectType.Function ? 'FUNCTION' : 'PROCEDURE');
                break;
            case DbObjectType.View:
                query = knex.select('TABLE_NAME AS name').from('INFORMATION_SCHEMA.TABLES')
                            .where('TABLE_SCHEMA', knex.raw('DATABASE()'))
                            .andWhere('TABLE_TYPE', 'VIEW');
                break;
            case DbObjectType.Trigger:
                query = knex.select('TRIGGER_NAME AS name').from('INFORMATION_SCHEMA.TRIGGERS')
                            .where('TRIGGER_SCHEMA', knex.raw('DATABASE()'));
                break;
            default:
                return Promise.resolve([]);
        }

        // noinspection JSMismatchedCollectionQueryUpdate
        const results = [];

        return /**@type Promise*/query.then(rows => {

            for (const row of rows) {
                results.push(row['name']);
            }

            return results;
        });
    }

    /**
     * Tests to see if an object is a view (good for tables)
     * @param {knex} knex
     * @param {String} tableName
     * @returns {Promise}
     */
    static isView(knex, tableName) {

        // noinspection JSUnresolvedFunction
        return /**@type Promise*/knex.select('TABLE_NAME')
                                     .from('information_schema.VIEWS')
                                     .where('TABLE_SCHEMA', knex.raw('SCHEMA()'))
                                     .andWhere('TABLE_NAME', tableName)
                                     .then(rows => rows.length && rows[0]['TABLE_NAME'] != null);
    }

    /**
     * Exports the routines only
     * @param {knex} knex
     * @param {NodeJS.WritableStream} outputStream
     * @param {MysqlBackupOptions} options
     * @returns {Promise}
     */
    static exportRoutines(knex, outputStream, options) {

        return this.getObjectList(knex, DbObjectType.Procedure)
                   .then(procedures =>
                       PromiseHelper.serial(procedures.map(procName => () => {

                           outputStream.write(
                               'DROP PROCEDURE IF EXISTS ' + wrapObjectName(procName) + ' ' + DELIMITER + NEW_LINE);

                           return MysqlBackupController
                               .getObjectCreate(knex, DbObjectType.Procedure, procName, false)
                               .then(createSql => {
                                   outputStream.write(createSql + ' ' + DELIMITER + NEW_LINE);
                               });
                       }))
                   )
                   .then(() => MysqlBackupController
                       .getObjectList(knex, DbObjectType.Function)
                       .then(functions =>
                           PromiseHelper.serial(functions.map(funcName => () => {

                               outputStream.write(
                                   'DROP PROCEDURE IF EXISTS ' + wrapObjectName(
                                   funcName) + ' ' + DELIMITER + NEW_LINE);

                               return MysqlBackupController.getObjectCreate(knex,
                                   DbObjectType.Function, funcName, false)
                                                           .then(createSql => {
                                                               outputStream.write(
                                                                   createSql + ' ' + DELIMITER + NEW_LINE);
                                                           });
                           }))
                       )
                   );

    }

    /**
     * Exports the tables and views structure (Tables first, as views depend on tables)
     * @param {knex} knex
     * @param {NodeJS.WritableStream} outputStream
     * @param {MysqlBackupOptions} options
     * @returns {Promise}
     */
    static exportTableStructure(knex, outputStream, options) {

        return this.getObjectList(knex, DbObjectType.Table)
                   .then(tables => {

                       const views = [];

                       return PromiseHelper
                           .serial(tables.map(tableName => () =>
                               MysqlBackupController
                                   .isView(knex, tableName)
                                   .then(isView => {

                                       if (isView) {
                                           views.push(tableName);
                                           return;
                                       }

                                       if (options.dropTable) {
                                           outputStream.write('DROP TABLE IF EXISTS ' + wrapObjectName(
                                               tableName) + ' ' + DELIMITER + NEW_LINE);
                                       }

                                       return MysqlBackupController
                                           .getObjectCreate(knex, DbObjectType.Table,
                                               tableName, !options.dropTable)
                                           .then(createSql => {
                                               outputStream.write(
                                                   createSql + ' ' + DELIMITER + NEW_LINE);
                                           });

                                   })))
                           .then(() => PromiseHelper
                               .serial(views.map(viewName => () => {
                                   if (options.dropTable) {
                                       outputStream.write('DROP VIEW IF EXISTS ' + wrapObjectName(
                                           viewName) + ' ' + DELIMITER + NEW_LINE);
                                   }

                                   return MysqlBackupController
                                       .getObjectCreate(knex, DbObjectType.View, viewName,
                                           !options.dropTable)
                                       .then(createSql => {
                                           outputStream.write(
                                               createSql + ' ' + DELIMITER + NEW_LINE);
                                       });
                               }))
                           );

                   });

    }

    /**
     * Exports the table data
     * @param {knex} knex
     * @param {NodeJS.WritableStream} outputStream
     * @param {MysqlBackupOptions} options
     * @returns {Promise}
     */
    static exportTableData(knex, outputStream, options) {

        return this.getObjectList(knex, DbObjectType.Table)
                   .then(tables =>
                       PromiseHelper.serial(tables.map(tableName => () =>
                           MysqlBackupController
                               .isView(knex, tableName)
                               .then(isView => {

                                   if (isView) return;

                                   const resolver = PromiseHelper.pending();

                                   // noinspection JSUnresolvedFunction
                                   knex.select('*')
                                       .from(tableName)
                                       // Dataset may be very large, we want to stream it in and out
                                       .stream(stream => {
                                           stream
                                               .on('data', row => {

                                                   outputStream.write(knex.insert(row)
                                                                          .into(tableName)
                                                                          .toString() + ' ' + DELIMITER + NEW_LINE);

                                               })
                                               .on('end', () => resolver.resolve());
                                       })
                                       .catch(resolver.reject);

                                   return resolver.promise;

                               })
                       ))
                   );

    }

    /**
     * Exports the table data
     * @param {knex} knex
     * @param {Writable} outputStream
     * @param {MysqlBackupOptions} options
     * @returns {Promise}
     */
    static exportTriggers(knex, outputStream, options) {

        return /**@type Promise*/knex.select(
            'TRIGGER_NAME AS Trigger',
            'ACTION_TIMING AS Timing',
            'ACTION_ORIENTATION AS Orientation',
            'EVENT_MANIPULATION AS Event',
            'EVENT_OBJECT_TABLE AS Table',
            'ACTION_STATEMENT AS Statement')
                                     .from('INFORMATION_SCHEMA.TRIGGERS')
                                     .where('TRIGGER_SCHEMA', knex.raw('DATABASE()'))
                                     .orderBy('ACTION_ORDER', 'asc')
                                     .then(rows => {

                                         for (const row of rows) {
                                             outputStream.write(
                                                 'CREATE TRIGGER ' + wrapObjectName(row['Trigger']) + ' ');
                                             outputStream.write(
                                                 row['Timing'] + ' ' + row['Event'] + ' ON ' + wrapObjectName(
                                                 row['Table']) + ' ');
                                             outputStream.write('FOR EACH ' + row['Orientation'] + ' ');
                                             outputStream.write(row['Statement'] + ' ' + DELIMITER + NEW_LINE);
                                         }

                                     });

    }

}

module.exports = MysqlBackupController;
