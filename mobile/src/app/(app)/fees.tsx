import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Alert, RefreshControl, View } from 'react-native';

import { Body, Button, Card, Empty, Label, Loading, Pill, Row, Screen, Title } from '@/components/ui';
import { formatDay, formatMoney, useInvoices } from '@/hooks/useData';
import { supabase } from '@/lib/supabase';
import type { Invoice, InvoiceStatus } from '@/lib/types';
import { spacing } from '@/theme';

function tone(status: InvoiceStatus): 'neutral' | 'live' | 'good' | 'bad' {
  switch (status) {
    case 'paid':
      return 'good';
    case 'overdue':
      return 'bad';
    case 'pending':
      return 'live';
    default:
      return 'neutral';
  }
}

export default function Fees() {
  const { invoices, loading, refresh } = useInvoices();
  const [paying, setPaying] = useState<string | null>(null);

  /**
   * The client sends only an invoice id -- never an amount. The edge function
   * looks up what this bill costs, and Razorpay's signed webhook is what marks
   * it paid. Nothing this screen does can settle an invoice on its own.
   */
  async function pay(invoice: Invoice) {
    setPaying(invoice.id);
    try {
      const { data, error } = await supabase.functions.invoke<{
        mode: 'mock' | 'razorpay';
        paid?: boolean;
        checkout_url?: string;
        error?: string;
      }>('create-payment-order', { body: { invoice_id: invoice.id } });

      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);

      if (data?.mode === 'mock') {
        Alert.alert(
          'Paid (test mode)',
          'This project is running with PAYMENTS_MODE=mock, so no real money moved. Set your Razorpay keys to take live payments.',
        );
        await refresh();
        return;
      }

      if (!data?.checkout_url) throw new Error('No checkout URL returned');

      await WebBrowser.openBrowserAsync(data.checkout_url);

      // Coming back from the browser does NOT mean the payment succeeded -- the
      // user may have closed the tab. Refresh and let the webhook be the judge;
      // if it has already landed, the invoice is now paid.
      await refresh();
    } catch (e) {
      Alert.alert('Payment failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setPaying(null);
    }
  }

  if (loading) return <Loading />;

  const outstanding = invoices.filter((i) => i.status !== 'paid' && i.status !== 'cancelled');
  const settled = invoices.filter((i) => i.status === 'paid');

  return (
    <Screen scroll refreshControl={<RefreshControl refreshing={false} onRefresh={() => void refresh()} />}>
      <Title sub="Bus fees for the students linked to your account.">Fees</Title>

      {invoices.length === 0 ? (
        <Empty title="No fees raised" hint="Bus fee invoices from your school will appear here." />
      ) : null}

      {outstanding.length > 0 ? <Label>Due</Label> : null}

      {outstanding.map((inv) => (
        <Card key={inv.id}>
          <Row>
            <View style={{ flex: 1, gap: 2 }}>
              <Body>{inv.rider_name}</Body>
              <Body muted>{inv.period_label}</Body>
            </View>
            <Pill label={inv.status} tone={tone(inv.status)} />
          </Row>

          <Row style={{ marginTop: spacing.sm }}>
            <View style={{ gap: 2 }}>
              <Label>Amount</Label>
              <Body>{formatMoney(inv.amount_paise, inv.currency)}</Body>
            </View>
            <View style={{ gap: 2, alignItems: 'flex-end' }}>
              <Label>Due</Label>
              <Body muted>{formatDay(inv.due_date)}</Body>
            </View>
          </Row>

          <View style={{ marginTop: spacing.md }}>
            <Button
              label={`Pay ${formatMoney(inv.amount_paise, inv.currency)}`}
              onPress={() => void pay(inv)}
              loading={paying === inv.id}
              disabled={paying !== null}
            />
          </View>
        </Card>
      ))}

      {settled.length > 0 ? <Label>Paid</Label> : null}

      {settled.map((inv) => (
        <Card key={inv.id} style={{ opacity: 0.75 }}>
          <Row>
            <View style={{ flex: 1, gap: 2 }}>
              <Body>{inv.rider_name}</Body>
              <Body muted>
                {inv.period_label} · {formatMoney(inv.amount_paise, inv.currency)}
              </Body>
            </View>
            <Pill label="Paid" tone="good" />
          </Row>

          {inv.receipt_no ? (
            <View style={{ gap: 2, marginTop: spacing.xs }}>
              <Label>Receipt</Label>
              <Body muted>{inv.receipt_no}</Body>
            </View>
          ) : null}
        </Card>
      ))}
    </Screen>
  );
}
