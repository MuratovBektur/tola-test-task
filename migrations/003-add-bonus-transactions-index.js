"use strict";

module.exports = {
  async up(queryInterface) {
    const indexes = await queryInterface.showIndex("bonus_transactions");

    const exists = indexes.some((idx) => idx.name === "uniq_user_request");

    if (exists) {
      return;
    }

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX uniq_user_request
      ON bonus_transactions (user_id, request_id)
      WHERE request_id IS NOT NULL;
    `);

    await queryInterface.removeIndex(
      "bonus_transactions",
      "bonus_transactions_request_id_uq",
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS uniq_user_request;
    `);
    await queryInterface.addIndex("bonus_transactions", ["request_id"], {
      name: "bonus_transactions_request_id_uq",
      unique: true,
    });
  },
};
