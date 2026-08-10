import { describe, expect, it } from 'vitest'
import { CARGO_PREMIUM } from '../../data/recipes'
import {
  CARGO_REQUIREMENTS,
  TRAILER_PRICE,
  VEHICLE_CLASSES,
} from '../../data/vehicles'
import type { CargoType, TrailerType } from '../types'
import { TRAILER_TYPES, canCarry, cargoFor, trailersFor } from './trailer'

/**
 * Тест совместимости — это тест ДАННЫХ не меньше, чем кода. Функции здесь
 * тривиальны (индекс по массиву), а дорого стоит другое: чтобы в справочнике
 * не оказалось груза, который никому не по кузову, и кузова, который не возит
 * ничего. И то и другое не падает, а тихо ломает игру — груз копится на складе
 * навсегда, купленный прицеп оказывается выброшенными деньгами.
 *
 * ПЕРЕЧНИ ВЫВОДЯТСЯ ИЗ ТИПОВ, а не переписываются сюда руками. Список грузов
 * берётся из CARGO_PREMIUM — это Record<CargoType, number>, то есть компилятор
 * держит его полным; список кузовов — из TRAILER_TYPES, собранного там же
 * полным Record. Поэтому новый груз или новый прицеп попадает под все проверки
 * ниже сам, без единой правки этого файла. Написать перечни списком литералов
 * значило бы получить тест, который зеленеет ровно потому, что о новом грузе не
 * знает.
 */

/** Все грузы игры. Полнота гарантирована типом CARGO_PREMIUM. */
const ALL_CARGO = Object.keys(CARGO_PREMIUM) as CargoType[]

describe('перечни', () => {
  it('в игре есть и грузы, и кузова', () => {
    // Страховка от вывода перечня из пустого объекта: без неё все переборы
    // ниже прошли бы вхолостую и тест был бы зелёным, ничего не проверив.
    expect(ALL_CARGO.length).toBeGreaterThan(0)
    expect(TRAILER_TYPES.length).toBeGreaterThan(0)
  })

  it('требования описаны ровно для существующих грузов и кузовов', () => {
    for (const requirement of CARGO_REQUIREMENTS) {
      expect(ALL_CARGO).toContain(requirement.cargo)
      for (const trailer of requirement.trailers) {
        expect(TRAILER_TYPES).toContain(trailer)
      }
    }
  })

  it('у каждого кузова есть цена, и каждая цена — за настоящий кузов', () => {
    // Прицеп без цены нельзя купить, цена без прицепа — мёртвая строка в
    // магазине. Оба справочника лежат в одном файле, и разъезжаются они молча.
    const priced = Object.keys(TRAILER_PRICE)
    expect([...TRAILER_TYPES].sort()).toEqual([...priced].sort())
    for (const trailer of TRAILER_TYPES) {
      expect(TRAILER_PRICE[trailer]).toBeGreaterThan(0)
    }
  })
})

describe('покрытие справочника', () => {
  it('каждый груз имеет хотя бы один подходящий кузов', () => {
    // Иначе груз производится, копится на складе и не вывозится ничем: цепочка
    // мертва, а причина не видна нигде, кроме этого теста.
    for (const cargo of ALL_CARGO) {
      expect(trailersFor(cargo).length).toBeGreaterThan(0)
    }
  })

  it('каждый кузов возит хотя бы один груз', () => {
    // Прицеп, не возящий ничего, — ловушка: игрок платит за него настоящие
    // деньги и получает машину, которая уходит порожней с любой остановки.
    for (const trailer of TRAILER_TYPES) {
      expect(cargoFor(trailer).length).toBeGreaterThan(0)
    }
  })

  it('каждый груз кому-то по силам: есть класс техники с подходящим кузовом', () => {
    // Совместимость груза с кузовом бесполезна, если такой кузов не цепляется
    // ни к одной машине в справочнике техники.
    for (const cargo of ALL_CARGO) {
      const fit = VEHICLE_CLASSES.filter((vc) =>
        vc.trailers.some((trailer) => canCarry(trailer, cargo)),
      )
      expect(fit.length).toBeGreaterThan(0)
    }
  })

  it('каждый класс техники может взять хотя бы один груз', () => {
    for (const vc of VEHICLE_CLASSES) {
      const carried = vc.trailers.flatMap((trailer) => cargoFor(trailer))
      expect(carried.length).toBeGreaterThan(0)
    }
  })
})

describe('canCarry', () => {
  it('тягач без прицепа не берёт ничего', () => {
    for (const cargo of ALL_CARGO) {
      expect(canCarry(null, cargo)).toBe(false)
    }
  })

  it('цистерна не берёт зерно, зерновоз не берёт топливо', () => {
    // Два самых показательных запрета: наливник не сыплет навал, а бункер не
    // возит наливное. Проверяется и обратная сторона — что запрет не тотальный
    // и каждый из этих кузовов свой груз всё-таки берёт.
    expect(canCarry('цистерна', 'зерно')).toBe(false)
    expect(canCarry('зерновоз', 'топливо')).toBe(false)

    expect(canCarry('цистерна', 'топливо')).toBe(true)
    expect(canCarry('зерновоз', 'зерно')).toBe(true)
  })

  it('согласована с обоими перечнями во всех парах', () => {
    // Полный перебор груз × кузов. Три функции обязаны отвечать одно и то же:
    // расхождение означало бы, что погрузка (canCarry) и интерфейс покупки
    // (trailersFor) живут по разным правилам, а игрок видит подсказку, которая
    // расходится с поведением машины.
    for (const cargo of ALL_CARGO) {
      for (const trailer of TRAILER_TYPES) {
        const fits = canCarry(trailer, cargo)
        expect(trailersFor(cargo).includes(trailer)).toBe(fits)
        expect(cargoFor(trailer).includes(cargo)).toBe(fits)
      }
    }
  })
})

describe('trailersFor и cargoFor', () => {
  it('повторяют требования из данных', () => {
    for (const requirement of CARGO_REQUIREMENTS) {
      // Порядок сохранён: первым идёт «родной» кузов, за ним вынужденные.
      expect(trailersFor(requirement.cargo)).toEqual(requirement.trailers)
    }
  })

  it('отдают копию, а не сам справочник', () => {
    // Отданный наружу массив рано или поздно кто-нибудь отсортирует под свою
    // панель. Справочник от этого поехал бы навсегда, а искали бы в погрузке.
    const cargo = CARGO_REQUIREMENTS[0].cargo
    const trailer = CARGO_REQUIREMENTS[0].trailers[0]

    const trailers = trailersFor(cargo)
    trailers.length = 0
    expect(trailersFor(cargo)).not.toHaveLength(0)
    expect(canCarry(trailer, cargo)).toBe(true)

    const cargoes = cargoFor(trailer)
    cargoes.length = 0
    expect(cargoFor(trailer)).not.toHaveLength(0)

    // И сами исходные данные не тронуты.
    expect(CARGO_REQUIREMENTS[0].trailers).toContain(trailer)
  })

  it('неизвестный груз и неизвестный кузов не везёт никто', () => {
    // Запрет, а не разрешение: забытая строчка в данных делает груз
    // неперевозимым и заметным, а не всемогущим. Приведение типов здесь
    // нарочно — так выглядит битое сохранение или груз, добавленный в тип и
    // забытый в требованиях.
    const ghostCargo = 'щебень' as CargoType
    const ghostTrailer = 'самосвал' as TrailerType

    expect(trailersFor(ghostCargo)).toEqual([])
    expect(cargoFor(ghostTrailer)).toEqual([])
    expect(canCarry('тент', ghostCargo)).toBe(false)
    expect(canCarry(ghostTrailer, 'зерно')).toBe(false)
  })
})
