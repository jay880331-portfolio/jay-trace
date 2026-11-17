import { Controller, Post } from "@nestjs/common";
import { JayTraceContextService, recordQuery } from "@jaytrace/nestjs";

@Controller("api/pay")
export class PaymentsController {
  constructor(private readonly jaytrace: JayTraceContextService) {}

  @Post()
  pay(): never {
    recordQuery("INSERT INTO payments (amount, card, status) VALUES (?, ?, ?)", {
      params: { amount: 4200, card: "4111111111111111", password: "hunter2", status: "pending" },
      durationMs: 320
    });
    this.jaytrace.addEvent("db", "db payment.create failed P2002", "error");
    const error = new Error("Unique constraint failed");
    error.name = "PrismaClientKnownRequestError";
    throw error;
  }
}
