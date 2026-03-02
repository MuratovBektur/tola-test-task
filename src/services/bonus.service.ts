import { Transaction } from 'sequelize';
import { sequelize } from '../db';
import { BonusTransaction } from '../models/BonusTransaction';
import { User } from '../models/User';

type AppError = Error & { status?: number };

function createAppError(message: string, status: number): AppError {
  const error = new Error(message) as AppError;
  error.status = status;
  return error;
}

export async function getUserBalance(
  userId: string,
  transaction: Transaction
): Promise<number> {
  const now = new Date();
  const ETERNITY = new Date('9999-12-31T23:59:59Z');

  const history = await BonusTransaction.findAll({
    where: { user_id: userId },
    order: [['created_at', 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE, // 🔥 критично для конкурентности
  });

  let activePool: { amount: number; created_at: Date; expires_at: Date }[] = [];

  for (const record of history) {
    if (record.type === 'accrual') {
      activePool.push({
        amount: record.amount,
        created_at: record.created_at,
        expires_at: record.expires_at
          ? new Date(record.expires_at)
          : ETERNITY,
      });
    } else if (record.type === 'spend') {
      let amountToSpend = record.amount;

      // сортировка по сроку сгорания (ближайшие раньше)
      activePool.sort(
        (a, b) => a.expires_at.getTime() - b.expires_at.getTime()
      );

      for (const packet of activePool) {
        if (amountToSpend <= 0) break;

        // если бонус уже истёк к моменту списания
        if (packet.expires_at <= record.created_at) {
          packet.amount = 0;
          continue;
        }

        if (packet.amount > 0) {
          const take = Math.min(packet.amount, amountToSpend);
          packet.amount -= take;
          amountToSpend -= take;
        }
      }
    }
  }

  // итоговый баланс — только неистёкшие
  return activePool.reduce((total, packet) => {
    if (packet.expires_at > now) {
      return total + packet.amount;
    }
    return total;
  }, 0);
}

/**
 * Полностью безопасное списание
 */
export async function spendBonus(
  userId: string,
  amount: number,
  requestId: string
) {
  if (!requestId) {
    throw createAppError('requestId is required', 400);
  }

  if (!amount || amount <= 0) {
    throw createAppError('Invalid amount', 400);
  }

  return sequelize.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
    async (t) => {
      // 1️⃣ Блокируем пользователя
      const user = await User.findByPk(userId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });


      if (!user) {
        throw createAppError('user not found', 400);
      }

      // 2️⃣ Проверяем идемпотентность
      const existingTx = await BonusTransaction.findOne({
        where: { user_id: userId, request_id: requestId },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });


      if (existingTx) {
        if (
          existingTx.type !== 'spend' ||
          existingTx.amount !== amount
        ) {
          throw createAppError(
            'Conflict: same requestId with different payload',
            409
          );
        }

        return {
          success: true,
          duplicated: true,
        };
      }

      // 3️⃣ Блокируем все бонусные транзакции пользователя
      await BonusTransaction.findAll({
        where: { user_id: userId },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      // 4️⃣ Проверяем баланс внутри транзакции
      const balance = await getUserBalance(userId, t);

      if (balance < amount) {
        throw createAppError('Not enough bonus', 400);
      }

      // 5️⃣ Создаём spend
      await BonusTransaction.create(
        {
          user_id: userId,
          type: 'spend',
          amount,
          expires_at: null,
          request_id: requestId,
        },
        { transaction: t }
      );


      return {
        success: true,
        duplicated: false,
      };
    }
  );
}