"""Create a small, non-destructive demo account and representative RD records."""
from datetime import date

from app import create_app
from app.extensions import db
from app.models import Agent, Customer, Payment
from app.services.audit_service import log_change
from app.services.payment_service import receipt_number


def main():
    app = create_app()
    with app.app_context():
        agent = Agent.query.filter_by(email="demo.rd.agent@example.com").first()
        if not agent:
            agent = Agent(name="Demo RD Agent", phone="98765 43210", email="demo.rd.agent@example.com")
            agent.set_password("ChangeMeDemo123!")
            db.session.add(agent)
            db.session.flush()

        accounts = {customer.account_number: customer for customer in Customer.query.filter_by(agent_id=agent.id).all()}
        sample = [
            ("Anita Sharma", "RD-10001", "98765 10001", "1500.00"),
            ("Vikram Iyer", "RD-10002", "98765 10002", "2000.00"),
            ("Meera Nair", "RD-10003", "98765 10003", "1000.00"),
        ]
        for name, account, phone, amount in sample:
            if account not in accounts:
                customer = Customer(
                    agent_id=agent.id,
                    customer_name=name,
                    account_number=account,
                    phone=phone,
                    monthly_rd_amount=amount,
                    start_date=date(2025, 1, 1),
                    maturity_date=date(2030, 1, 1),
                    status="active",
                )
                db.session.add(customer)
                db.session.flush()
                log_change(agent.id, "SEED_CREATE", "customer", customer.id, new_value=customer.public_dict())
                accounts[account] = customer

        month, year = date.today().month, date.today().year
        for account in ("RD-10001", "RD-10002"):
            customer = accounts[account]
            if not Payment.query.filter_by(customer_id=customer.id, month=month, year=year).first():
                payment = Payment(customer_id=customer.id, month=month, year=year, amount=customer.monthly_rd_amount, payment_date=date.today(), receipt_number=receipt_number(agent.id))
                db.session.add(payment)
                db.session.flush()
                log_change(agent.id, "SEED_CREATE", "payment", payment.id, new_value=payment.public_dict())
        db.session.commit()
        print("Demo data ready. Login: 98765 43210 / ChangeMeDemo123!")


if __name__ == "__main__":
    main()
