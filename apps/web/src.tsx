import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const base = import.meta.env.VITE_API_URL || 'http://localhost:4000';
type Product = { id: string; title: string; description: string; price: number; stock: number };
type Item = {
  productId: string;
  title: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
};
type Cart = { version: number; items: Item[]; subtotal: number; quantity: number };
type Delivery =
  | { method: 'pickup'; pickupPointId: string }
  | {
      method: 'courier';
      address: { city: string; street: string; house: string; apartment?: string };
    };
type Quote = {
  id: string;
  items: Item[];
  subtotal: number;
  shipping: number;
  total: number;
  delivery: Delivery;
};
type Order = {
  id: string;
  number: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  items: Item[];
  subtotal: number;
  shipping: number;
  total: number;
  delivery: Delivery;
};
type Payment = {
  id: string;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
};
type ApiError = Error & { code?: string; fields?: { path: string; message: string }[] };
const readyForQuote = (delivery: Delivery) =>
  delivery.method === 'pickup' ||
  Boolean(
    delivery.address.city.trim() && delivery.address.street.trim() && delivery.address.house.trim(),
  );
const money = (value: number) =>
  new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(value / 100);
const key = () => crypto.randomUUID();

class Client {
  token = localStorage.getItem('checkout-token') || '';
  async request<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set('Content-Type', 'application/json');
    if (auth && this.token) headers.set('Authorization', `Bearer ${this.token}`);
    let response: Response;
    try {
      response = await fetch(base + path, { ...init, headers });
    } catch {
      throw Object.assign(new Error('Не удалось связаться с сервером. Попробуйте ещё раз.'), {
        code: 'NETWORK',
      });
    }
    if (response.status === 204) return undefined as T;
    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new Error('Сервер вернул непонятный ответ.');
    }
    if (!response.ok)
      throw Object.assign(
        new Error(body?.error?.message || 'Запрос не выполнен.'),
        body?.error || {},
      );
    return body.data as T;
  }
  async session() {
    const data = await this.request<{ token: string }>(
      '/api/sessions',
      { method: 'POST', body: '{}' },
      false,
    );
    this.token = data.token;
    localStorage.setItem('checkout-token', data.token);
    return data;
  }
}
const api = new Client();

function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Cart | null>(null);
  const [view, setView] = useState<'catalog' | 'checkout' | 'payment' | 'success'>('catalog');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [delivery, setDelivery] = useState<Delivery>({
    method: 'pickup',
    pickupPointId: 'point-center',
  });
  const [payment, setPayment] = useState('card');
  const [customer, setCustomer] = useState({ name: '', email: '', phone: '' });
  const [cards, setCards] = useState<
    { id: string; title: string; maskedNumber: string; scenario: 'success' | 'decline' }[]
  >([]);
  const [card, setCard] = useState('');
  const report = (error: unknown) => setNotice((error as Error).message);
  const polling = useRef<number | undefined>(undefined);
  const changing = useRef(new Set<string>());
  const cartItems = useMemo(() => {
    const byProduct = new Map<string, Item>();
    for (const item of cart?.items || []) byProduct.set(item.productId, item);
    return byProduct;
  }, [cart]);
  const loaded = useRef(false);
  const quoteRequest = useRef(0);
  const loadCart = useCallback(async () => {
    const fresh = await api.request<Cart>('/api/cart');
    setCart(fresh);
    return fresh;
  }, []);
  const openPayment = useCallback(async () => {
    const sandbox = await api.request<{ cards: typeof cards }>('/api/sandbox');
    setCards(sandbox.cards);
    setCard(sandbox.cards[0]?.id || '');
    setView('payment');
  }, []);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    (async () => {
      try {
        if (!api.token) await api.session();
        const [catalog] = await Promise.all([api.request<Product[]>('/api/products'), loadCart()]);
        setProducts(catalog);
        const saved = localStorage.getItem('checkout-order');
        if (saved) {
          const current = await api.request<Order>(`/api/orders/${saved}`);
          setOrder(current);
          if (current.status === 'paid' || current.status === 'confirmed') setView('success');
          else {
            await openPayment();
            if (current.paymentStatus === 'pending') {
              const attempts = await api.request<Payment[]>(`/api/orders/${current.id}/payments`);
              const active = attempts.find(
                (attempt) => attempt.status === 'pending' || attempt.status === 'processing',
              );
              if (active) watchPayment(current.id, active.id);
            }
          }
        }
      } catch (e) {
        report(e);
      }
    })();
    return () => window.clearTimeout(polling.current);
  }, [loadCart, openPayment]);
  const changeItem = async (id: string, quantity: number) => {
    if (changing.current.has(id)) return;
    changing.current.add(id);
    try {
      if (quantity < 1) await api.request(`/api/cart/items/${id}`, { method: 'DELETE' });
      else
        await api.request(`/api/cart/items/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ quantity }),
        });
      await loadCart();
    } catch (e) {
      report(e);
    } finally {
      changing.current.delete(id);
    }
  };
  const calculate = async (currentCart = cart) => {
    if (!currentCart?.items.length || !readyForQuote(delivery)) {
      setQuote(null);
      return;
    }
    const request = ++quoteRequest.current;
    setBusy(true);
    try {
      const next = await api.request<Quote>('/api/quotes', {
        method: 'POST',
        body: JSON.stringify({ cartVersion: currentCart.version, delivery }),
      });
      if (request === quoteRequest.current) setQuote(next);
    } catch (e) {
      report(e);
    } finally {
      if (request === quoteRequest.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (view === 'checkout') void calculate();
  }, [delivery, cart?.version]);
  const createOrder = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!quote) return;
    setBusy(true);
    try {
      const created = await api.request<Order>('/api/orders', {
        method: 'POST',
        headers: { 'Idempotency-Key': key() },
        body: JSON.stringify({ quoteId: quote.id, paymentMethod: payment, customer }),
      });
      setOrder(created);
      localStorage.setItem('checkout-order', created.id);
      await loadCart();
      if (payment === 'cash_on_delivery') setView('success');
      else {
        await openPayment();
      }
    } catch (e: any) {
      if (e.code === 'CART_VERSION_CONFLICT' || e.code === 'QUOTE_EXPIRED') {
        await calculate(await loadCart());
      }
      report(e);
    } finally {
      setBusy(false);
    }
  };
  const checkOrder = async (id: string) => {
    const fresh = await api.request<Order>(`/api/orders/${id}`);
    setOrder(fresh);
    if (fresh.status === 'paid') {
      setView('success');
      return true;
    }
    return false;
  };
  const watchPayment = (orderId: string, paymentId: string) => {
    setBusy(true);
    const poll = async () => {
      try {
        if (await checkOrder(orderId)) {
          setBusy(false);
          return;
        }
        const paymentState = await api.request<Payment>(`/api/payments/${paymentId}`);
        if (paymentState.status === 'failed' || paymentState.status === 'cancelled') {
          setNotice(
            paymentState.status === 'failed'
              ? 'Банк отклонил карту. Выберите другую и повторите.'
              : 'Оплата отменена.',
          );
          setBusy(false);
          return;
        }
        polling.current = window.setTimeout(poll, 900);
      } catch (e) {
        report(e);
        setBusy(false);
      }
    };
    polling.current = window.setTimeout(poll, 700);
  };
  const pay = async () => {
    if (!order || !card) return;
    setBusy(true);
    try {
      const attempt = await api.request<{ id: string }>(`/api/orders/${order.id}/payments`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key() },
        body: '{}',
      });
      const choice = cards.find((x) => x.id === card)!;
      await api.request(`/api/payments/${attempt.id}/simulations`, {
        method: 'POST',
        body: JSON.stringify({ scenario: choice.scenario }),
      });
      watchPayment(order.id, attempt.id);
    } catch (e) {
      report(e);
      setBusy(false);
    }
  };
  if (view === 'success' && order)
    return (
      <main className="success">
        <p className="eyebrow">Заказ оформлен</p>
        <h1>Спасибо!</h1>
        <p>
          Заказ <b>№ {order.number}</b>
          {order.paymentMethod === 'cash_on_delivery' ? ' — оплата при получении.' : ' оплачен.'}
        </p>
        <OrderSummary order={order} />
        <button
          onClick={() => {
            localStorage.removeItem('checkout-order');
            setView('catalog');
          }}
        >
          Вернуться к каталогу
        </button>
      </main>
    );
  return (
    <main>
      <header>
        <a className="brand" onClick={() => setView('catalog')}>
          мера
        </a>
        <button
          className="cart-button"
          onClick={() => setView(view === 'checkout' ? 'catalog' : 'checkout')}
        >
          Корзина <span>{cart?.quantity || 0}</span>
        </button>
      </header>
      {notice && (
        <div className="notice">
          {notice}
          <button onClick={() => setNotice('')}>×</button>
        </div>
      )}
      {view === 'catalog' && (
        <>
          <section className="intro">
            <p className="eyebrow">Небольшие вещи для большого дома</p>
            <h1>
              Свет, который
              <br />
              остаётся с вами.
            </h1>
          </section>
          <section className="products">
            {products.map((p) => (
              <article className="product" key={p.id}>
                <div className="product-image">{p.title.slice(0, 1)}</div>
                <p>{p.description}</p>
                <h2>{p.title}</h2>
                <div>
                  <b>{money(p.price)}</b>
                  <button
                    disabled={!p.stock}
                    onClick={() => changeItem(p.id, (cartItems.get(p.id)?.quantity || 0) + 1)}
                  >
                    {p.stock ? 'Добавить' : 'Нет в наличии'}
                  </button>
                </div>
              </article>
            ))}
          </section>
        </>
      )}
      {view === 'checkout' && (
        <section className="checkout">
          <div>
            <button className="back" onClick={() => setView('catalog')}>
              ← Продолжить покупки
            </button>
            <h1>Оформление</h1>
            {cart?.items.length ? (
              <>
                <div className="cart-list">
                  {cart.items.map((i) => (
                    <div className="cart-item" key={i.productId}>
                      <div>
                        <b>{i.title}</b>
                        <small>{money(i.unitPrice)} за шт.</small>
                      </div>
                      <div className="quantity">
                        <button
                          onClick={() => changeItem(i.productId, i.quantity - 1)}
                          aria-label="Уменьшить"
                        >
                          −
                        </button>
                        <span>{i.quantity}</span>
                        <button
                          onClick={() => changeItem(i.productId, i.quantity + 1)}
                          aria-label="Увеличить"
                        >
                          +
                        </button>
                      </div>
                      <b>{money(i.lineTotal)}</b>
                    </div>
                  ))}
                </div>
                <form onSubmit={createOrder}>
                  <h2>Доставка</h2>
                  <label className="choice">
                    <input
                      type="radio"
                      checked={delivery.method === 'pickup'}
                      onChange={() =>
                        setDelivery({ method: 'pickup', pickupPointId: 'point-center' })
                      }
                    />
                    Самовывоз <small>Бесплатно</small>
                  </label>
                  {delivery.method === 'pickup' && (
                    <select
                      value={delivery.pickupPointId}
                      onChange={(e) =>
                        setDelivery({ method: 'pickup', pickupPointId: e.target.value })
                      }
                    >
                      <option value="point-center">Центральный — ул. Примерная, 10</option>
                      <option value="point-north">Северный — пр. Мира, 7</option>
                    </select>
                  )}
                  <label className="choice">
                    <input
                      type="radio"
                      checked={delivery.method === 'courier'}
                      onChange={() =>
                        setDelivery({
                          method: 'courier',
                          address: { city: '', street: '', house: '' },
                        })
                      }
                    />
                    Курьер <small>от {money(39000)}</small>
                  </label>
                  {delivery.method === 'courier' && (
                    <div className="address">
                      {(['city', 'street', 'house', 'apartment'] as const).map((name) => (
                        <input
                          key={name}
                          required={name !== 'apartment'}
                          placeholder={
                            { city: 'Город', street: 'Улица', house: 'Дом', apartment: 'Квартира' }[
                              name
                            ]
                          }
                          value={delivery.address[name] || ''}
                          onChange={(e) =>
                            setDelivery({
                              method: 'courier',
                              address: { ...delivery.address, [name]: e.target.value },
                            })
                          }
                        />
                      ))}
                    </div>
                  )}
                  <h2>Контакты</h2>
                  {(['name', 'email', 'phone'] as const).map((name) => (
                    <label className="field" key={name}>
                      {{ name: 'Имя', email: 'Email', phone: 'Телефон' }[name]}
                      <input
                        required
                        type={name === 'email' ? 'email' : name === 'phone' ? 'tel' : 'text'}
                        pattern={name === 'phone' ? '\\+[1-9]\\d{9,14}' : undefined}
                        placeholder={name === 'phone' ? '+79990000000' : undefined}
                        value={customer[name]}
                        onChange={(e) => setCustomer({ ...customer, [name]: e.target.value })}
                      />
                    </label>
                  ))}
                  <h2>Оплата</h2>
                  <label className="choice">
                    <input
                      type="radio"
                      checked={payment === 'card'}
                      onChange={() => setPayment('card')}
                    />
                    Картой онлайн
                  </label>
                  <label className="choice">
                    <input
                      type="radio"
                      checked={payment === 'cash_on_delivery'}
                      onChange={() => setPayment('cash_on_delivery')}
                    />
                    Наличными при получении
                  </label>
                  <button disabled={busy || !quote} className="primary">
                    {busy ? 'Проверяем…' : 'Оформить заказ'}
                  </button>
                </form>
              </>
            ) : (
              <p>Корзина пока пуста.</p>
            )}
          </div>
          {quote && (
            <aside>
              <h2>Итого</h2>
              <p>
                Товары <b>{money(quote.subtotal)}</b>
              </p>
              <p>
                Доставка <b>{money(quote.shipping)}</b>
              </p>
              <hr />
              <h2>{money(quote.total)}</h2>
            </aside>
          )}
        </section>
      )}
      {view === 'payment' && order && (
        <section className="payment">
          <p className="eyebrow">Тестовая оплата</p>
          <h1>Оплатить {money(order.total)}</h1>
          <p>Выберите тестовую карту. Номер карты и CVC по условиям задания не вводятся.</p>
          {cards.map((c) => (
            <label className="test-card" key={c.id}>
              <input type="radio" checked={card === c.id} onChange={() => setCard(c.id)} />
              <span>
                {c.title}
                <small>{c.maskedNumber}</small>
              </span>
            </label>
          ))}
          <div>
            <button onClick={() => setView('checkout')}>Отмена</button>
            <button className="primary" disabled={busy} onClick={pay}>
              {busy ? 'Проверяем оплату…' : 'Оплатить'}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
function OrderSummary({ order }: { order: Order }) {
  return (
    <section className="order-summary">
      {order.items.map((x) => (
        <p key={x.productId}>
          {x.title} × {x.quantity}
          <b>{money(x.lineTotal)}</b>
        </p>
      ))}
      <p>
        Доставка<b>{money(order.shipping)}</b>
      </p>
      <hr />
      <h2>{money(order.total)}</h2>
    </section>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
